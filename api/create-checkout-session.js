export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Falta configurar STRIPE_SECRET_KEY en Vercel.' });

  try {
    const { cart } = req.body || {};
    if (!Array.isArray(cart) || !cart.length) return res.status(400).json({ error: 'El carrito está vacío.' });

    const prices = {
      'Totebag sencillo': 25,
      'Bolsa': 25,
      'Neceser S': 15,
      'Neceser Basic': 20,
      'Babero': 10,
      'Pack bebé': 50,
      'Lanyard': 10
    };

    const cleanCart = cart.filter(item => item && prices[item.name]);
    if (cleanCart.length !== cart.length) return res.status(400).json({ error: 'Hay un producto no configurado para pago.' });

    // Promoción: Totebag/Bolsa + Neceser Basic + Neceser S = Lanyard gratis.
    const qualifiesForGift = cleanCart.some(x => x.name === 'Bolsa' || x.name === 'Totebag sencillo') && cleanCart.some(x => x.name === 'Neceser Basic') && cleanCart.some(x => x.name === 'Neceser S');
    const valid = cleanCart.filter(x => !x.promoGift);
    if (qualifiesForGift) valid.push({ name: 'Lanyard', fabric: (cleanCart.find(x => x.promoGift)?.fabric || 'Color elegido en carrito'), qty: 1, promoGift: true });

    const origin = req.headers.origin || 'https://monimpasse.com';
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', origin + '/?checkout=success');
    params.set('cancel_url', origin + '/?checkout=cancelled');
    params.set('billing_address_collection', 'required');
    params.set('shipping_address_collection[allowed_countries][0]', 'ES');
    params.set('automatic_tax[enabled]', 'true');

    let subtotal = 0;
    valid.forEach((item, index) => {
      const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
      const isGift = item.promoGift === true;
      const unitAmount = isGift ? 0 : prices[item.name] * 100;
      if (!isGift) subtotal += prices[item.name] * qty;
      params.set(`line_items[${index}][price_data][currency]`, 'eur');
      params.set(`line_items[${index}][price_data][unit_amount]`, String(unitAmount));
      params.set(`line_items[${index}][price_data][product_data][name]`, item.promoGift ? 'Lanyard de regalo' : item.name);
      const details = [item.promoGift ? 'Promoción: Totebag + Neceser Basic + Neceser S' : item.fabric, item.personalized ? 'Nombre: ' + item.personalized : ''].filter(Boolean).join(' · ');
      if (details) params.set(`line_items[${index}][price_data][product_data][description]`, details);
      params.set(`line_items[${index}][quantity]`, String(qty));
    });

    // Envío: Península 4,99 € y gratis desde 50 €. Canarias/Ceuta/Melilla 7,99 € y gratis desde 80 €.
    // Stripe Checkout recoge la dirección; las tarifas se restringen por país/región en Stripe.
    if (subtotal < 50) params.set('shipping_options[0][shipping_rate]', 'shr_1U8iR5AAQ3x48Iizd7mKKegn');

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const session = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: session.error?.message || 'No se pudo crear el pago.' });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({ error: 'No se pudo iniciar el pago.' });
  }
}