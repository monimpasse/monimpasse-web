export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Falta configurar STRIPE_SECRET_KEY en Vercel.' });

  try {
    const { cart, userId = null } = req.body || {};
    if (!Array.isArray(cart) || !cart.length) return res.status(400).json({ error: 'El carrito está vacío.' });

    const prices = {'Totebag sencillo':25,'Bolsa':25,'Neceser S':15,'Neceser Basic':20,'Babero':10,'Pack bebé':50,'Lanyard':10};
    const cleanCart = cart.filter(item => item && prices[item.name]);
    if (cleanCart.length !== cart.length) return res.status(400).json({ error: 'Hay un producto no configurado para pago.' });

    const qualifiesForGift =
      cleanCart.some(x => x.name === 'Bolsa' || x.name === 'Totebag sencillo') &&
      cleanCart.some(x => x.name === 'Neceser Basic') &&
      cleanCart.some(x => x.name === 'Neceser S');

    const valid = cleanCart.filter(item => !item.promoGift);
    if (qualifiesForGift && !valid.some(item => item.name === 'Lanyard' && item.promoGift === true)) {
      const gift = cleanCart.find(x => x.promoGift);
      valid.push({name:'Lanyard',fabric:gift?.fabric || 'Color elegido en carrito',qty:1,promoGift:true});
    }

    const origin = req.headers.origin || 'https://monimpasse.com';
    const params = new URLSearchParams();
    params.set('mode','payment');
    params.set('success_url',origin+'/?checkout=success');
    params.set('cancel_url',origin+'/?checkout=cancelled');
    params.set('billing_address_collection','required');
    params.set('shipping_address_collection[allowed_countries][0]','ES');
    params.set('automatic_tax[enabled]','true');

    if (userId && /^[0-9a-f-]{36}$/i.test(String(userId))) params.set('metadata[user_id]',String(userId));

    let subtotal=0;
    valid.forEach((item,index)=>{
      const qty=Math.max(1,Math.min(99,Number(item.qty)||1));
      const gift=item.promoGift===true;
      const personalType=item.personalType==='name'||item.personalType==='initial'?item.personalType:'none';
      const extra=personalType==='name'?5:personalType==='initial'?3:0;
      const unitPrice=gift?0:prices[item.name]+extra;
      if(!gift) subtotal+=unitPrice*qty;
      params.set(`line_items[${index}][price_data][currency]`,'eur');
      params.set(`line_items[${index}][price_data][unit_amount]`,String(Math.round(unitPrice*100)));
      params.set(`line_items[${index}][price_data][product_data][name]`,gift?'Lanyard de regalo':item.name);
      const details=[
        item.fabric?'Tela: '+item.fabric:'',
        personalType==='name'&&item.personalized?'Nombre: '+item.personalized:'',
        personalType==='initial'&&item.personalized?'Inicial: '+item.personalized:'',
        gift?'Promoción: Totebag + Neceser Basic + Neceser S':''
      ].filter(Boolean).join(' · ');
      if(details) params.set(`line_items[${index}][price_data][product_data][description]`,details);
      params.set(`line_items[${index}][quantity]`,String(qty));
    });

    if(subtotal<50) params.set('shipping_options[0][shipping_rate]','shr_1U8iR5AAQ3x48Iizd7mKKegn');

    const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{
      method:'POST',
      headers:{Authorization:'Bearer '+secretKey,'Content-Type':'application/x-www-form-urlencoded'},
      body:params.toString()
    });
    const session=await response.json();
    if(!response.ok) return res.status(response.status).json({error:session.error?.message||'No se pudo crear el pago.'});
    return res.status(200).json({url:session.url});
  } catch(error) {
    console.error('Checkout error:',error);
    return res.status(500).json({error:'No se pudo iniciar el pago.'});
  }
}
