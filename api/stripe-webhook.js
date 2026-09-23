import crypto from 'crypto';

export const config={api:{bodyParser:false}};

function readRawBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    req.on('data',chunk=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}

function verifyStripeSignature(payload,signature,secret){
  if(!signature)return false;
  const parts=signature.split(',').reduce((a,p)=>{const [k,v]=p.split('=');if(k&&v)a[k]=v;return a;},{});
  if(!parts.t||!parts.v1)return false;
  const timestamp=Number(parts.t);
  if(!Number.isFinite(timestamp)||Math.abs(Date.now()/1000-timestamp)>300)return false;
  const expected=crypto.createHmac('sha256',secret).update(parts.t+'.'+payload,'utf8').digest('hex');
  try{return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1));}catch{return false;}
}

async function stripeGet(path,secret){
  const r=await fetch('https://api.stripe.com/v1/'+path,{headers:{Authorization:'Bearer '+secret}});
  const d=await r.json();
  if(!r.ok)throw new Error(d?.error?.message||'Stripe API error');
  return d;
}

async function supabaseRequest(path,method,body,url,key){
  const r=await fetch(url+'/rest/v1/'+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body)});
  const t=await r.text();let d=null;try{d=t?JSON.parse(t):null}catch{}
  if(!r.ok)throw new Error(d?.message||d?.error_description||t||'Supabase API error');
  return d;
}

function parseDescription(description=''){
  const result={fabric:null,personalization_type:null,personalization_value:null,promo_gift:false};
  for(const part of description.split(' · ')){
    if(part.startsWith('Tela: '))result.fabric=part.slice(6);
    else if(part.startsWith('Nombre: ')){result.personalization_type='name';result.personalization_value=part.slice(8);}
    else if(part.startsWith('Inicial: ')){result.personalization_type='initial';result.personalization_value=part.slice(9);}
    else if(part.startsWith('Promoción: '))result.promo_gift=true;
  }
  return result;
}

function makeOrderNumber(){
  const stamp=new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,12);
  return 'MI-'+stamp+'-'+Math.floor(100+Math.random()*900);
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const webhookSecret=process.env.STRIPE_WEBHOOK_SECRET;
  const stripeSecret=process.env.STRIPE_SECRET_KEY;
  const supabaseUrl=process.env.SUPABASE_URL||'https://pgunvsjrytujpkjbwyaz.supabase.co';
  const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!webhookSecret||!stripeSecret||!serviceKey)return res.status(500).json({error:'Webhook no configurado.'});

  try{
    const raw=await readRawBody(req);
    if(!verifyStripeSignature(raw.toString('utf8'),req.headers['stripe-signature'],webhookSecret))return res.status(400).json({error:'Firma de Stripe no válida.'});
    const event=JSON.parse(raw.toString('utf8'));
    if(event.type!=='checkout.session.completed')return res.status(200).json({received:true});

    const session=event.data.object;
    const existing=await supabaseRequest('orders?select=id,order_number&stripe_checkout_session_id=eq.'+encodeURIComponent(session.id),'GET',undefined,supabaseUrl,serviceKey);
    if(Array.isArray(existing)&&existing.length)return res.status(200).json({received:true,order_number:existing[0].order_number});

    const lineItems=await stripeGet('checkout/sessions/'+encodeURIComponent(session.id)+'/line_items?limit=100',stripeSecret);
    const customer=session.customer_details||{};
    const shipping=session.shipping_details||{};
    const address=shipping.address||customer.address||null;
    const total=Number(session.amount_total||0)/100;
    const lineData=lineItems.data||[];
    const isShippingItem=item=>String(item.description||'').startsWith('Envío ')||String(item.price?.product?.name||'').startsWith('Envío ');
    const customShippingAmount=lineData.filter(isShippingItem).reduce((sum,item)=>sum+Number(item.amount_total||0)/100,0);
    const shippingAmount=Number(session.total_details?.amount_shipping||0)/100 || customShippingAmount;
    const orderRows=await supabaseRequest('orders','POST',{
      order_number:makeOrderNumber(),
      user_id:session.metadata?.user_id||null,
      stripe_checkout_session_id:session.id,
      stripe_payment_intent_id:session.payment_intent||null,
      customer_email:customer.email||session.customer_email||'',
      customer_name:customer.name||shipping.name||null,
      shipping_address:address?{name:shipping.name||customer.name||null,line1:address.line1||null,line2:address.line2||null,city:address.city||null,state:address.state||null,postal_code:address.postal_code||null,country:address.country||null}:null,
      subtotal:Math.max(0,total-shippingAmount),
      shipping_amount:shippingAmount,
      total_amount:total,
      currency:session.currency||'eur',
      status:'paid'
    },supabaseUrl,serviceKey);
    const order=orderRows?.[0];
    if(!order)throw new Error('No se pudo crear el pedido.');
    await supabaseRequest('site_events','POST',{user_id:session.metadata?.user_id||null,session_id:session.id,event_type:'purchase',product_name:null,quantity:lineData.filter(item=>!isShippingItem(item)).reduce((s,item)=>s+Number(item.quantity||1),0),value:total,metadata:{order_number:order.order_number,shipping_amount:shippingAmount}},supabaseUrl,serviceKey);

    const items=lineData.filter(item=>!isShippingItem(item)).map(item=>{
      const description=item.description||'';
      const parsed=parseDescription(description);
      return {
        order_id:order.id,
        product_name:(item.price?.product && typeof item.price.product==='object' && item.price.product.name)?item.price.product.name:(description.startsWith('Promoción:')?'Lanyard de regalo':(item.price_data?.product_data?.name||'Producto')),
        quantity:Number(item.quantity||1),
        unit_amount:Number(item.price?.unit_amount||0)/100,
        fabric:parsed.fabric,
        personalization_type:parsed.personalization_type,
        personalization_value:parsed.personalization_value,
        promo_gift:parsed.promo_gift||(Number(item.price?.unit_amount||0)===0)
      };
    });
    if(items.length)await supabaseRequest('order_items','POST',items,supabaseUrl,serviceKey);
    return res.status(200).json({received:true});
  }catch(error){
    console.error('Stripe webhook error:',error);
    return res.status(500).json({error:'No se pudo registrar el pedido.'});
  }
}
