export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Falta configurar STRIPE_SECRET_KEY en Vercel.' });
  }

  try {
    const { cart } = req.body || {};
    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío.' });
    }

    const totebagPriceId = 'price_1U8QzVAAQ3x48IizAm62Us4r';
    const items = cart.filter(item => item && item.name === 'Totebag sencillo');

    if (items.length !== cart.length) {
      return res.status(400).json({ error: 'Hay un producto que todavía no está configurado para pago.' });
    }

    const lineItems = items.map(item => ({
      price: totebagPriceId,
      quantity: Math.max(1, Math.min(99, Number(item.qty) || 1))
    }));

    const subtotal = items.reduce((sum, item) => {
      return sum + 25 * Math.max(1, Math.min(99, Number(item.qty) || 1));
    }, 0);

    const origin = req.headers.origin || 'https://monimpasse.com';
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', `${origin}/?checkout=success`);
    params.set('cancel_url', `${origin}/?checkout=cancelled`);
    params.set('billing_address_collection', 'required');
    params.set('shipping_address_collection[allowed_countries][0]', 'ES');
    params.set('automatic_tax[enabled]', 'true');

    lineItems.forEach((item, index) => {
      params.set(`line_items[${index}][price]`, item.price);
      params.set(`line_items[${index}][quantity]`, String(item.quantity));
    });

    if (subtotal < 50) {
      params.set('shipping_options[0][shipping_rate]', 'shr_1U8iR5AAQ3x48Iizd7mKKegn');
    }

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const session = await response.json();
    if (!response.ok) {
      console.error('Stripe error:', session);
      return res.status(response.status).json({ error: session.error?.message || 'No se pudo crear el pago.' });
    }

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({ error: 'No se pudo iniciar el pago.' });
  }
}
