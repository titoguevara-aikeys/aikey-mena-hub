import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Create Supabase client using the anon key for user authentication
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    // Authenticate user
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");

    // Parse request body
    const body = await req.json();
    const { virtualCardId, deliveryOption, deliveryPrice, address } = body;

    // Initialize Stripe
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2023-10-16",
    });

    // Check if a Stripe customer record exists for this user
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    }

    // Calculate total amount (card issuance + delivery)
    const cardIssuancePrice = 15.00; // $15.00 for physical card
    const totalAmount = Math.round((cardIssuancePrice + deliveryPrice) * 100); // Convert to cents

    // Create payment session for physical card
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { 
              name: "Physical Card Issuance",
              description: "Physical card production and setup"
            },
            unit_amount: Math.round(cardIssuancePrice * 100),
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: "usd",
            product_data: { 
              name: `${deliveryOption === 'express' ? 'Express' : 'Standard'} Delivery`,
              description: deliveryOption === 'express' 
                ? "2-3 business days delivery" 
                : "7-10 business days delivery"
            },
            unit_amount: Math.round(deliveryPrice * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.headers.get("origin")}/cards?physical_card_success=true`,
      cancel_url: `${req.headers.get("origin")}/cards?physical_card_cancelled=true`,
      metadata: {
        virtual_card_id: virtualCardId,
        delivery_option: deliveryOption,
        user_id: user.id,
        shipping_address: JSON.stringify(address)
      }
    });

    // Store the physical card order in database (optional)
    const supabaseService = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    await supabaseService.from("physical_card_orders").insert({
      user_id: user.id,
      virtual_card_id: virtualCardId,
      stripe_session_id: session.id,
      delivery_option: deliveryOption,
      delivery_price: deliveryPrice,
      card_issuance_price: cardIssuancePrice,
      total_amount: totalAmount / 100,
      shipping_address: address,
      status: "pending",
      created_at: new Date().toISOString()
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error: any) {
    console.error("Error creating physical card payment:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});