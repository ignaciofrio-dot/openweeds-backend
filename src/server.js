import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { readJson, writeJson } from "./storage.js";
import { createToken, requireAuth } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

if (!process.env.JWT_SECRET) {
  throw new Error("Falta JWT_SECRET en .env");
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (frontendUrls.length === 0 || frontendUrls.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origen no permitido por CORS"));
  },
  credentials: false
}));
app.use(express.json());
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

let mpClient = null;
if (mpAccessToken) {
  mpClient = new MercadoPagoConfig({ accessToken: mpAccessToken });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "openweeds-api" });
});

app.get("/api/products", (_req, res) => {
  const products = readJson("products.json");
  res.json(products);
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email y password validos requeridos" });
  }

  const users = readJson("users.json");
  const exists = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: "El usuario ya existe" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = { id: uuidv4(), email, passwordHash, createdAt: new Date().toISOString() };
  users.push(newUser);
  writeJson("users.json", users);

  const token = createToken(newUser);
  return res.status(201).json({ token, user: { id: newUser.id, email: newUser.email } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email y password son requeridos" });
  }

  const users = readJson("users.json");
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: "Credenciales invalidas" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Credenciales invalidas" });
  }

  const token = createToken(user);
  return res.json({ token, user: { id: user.id, email: user.email } });
});

app.post("/api/orders/checkout", requireAuth, async (req, res) => {
  const { items, shipping, shippingCost, shippingAddress } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "El carrito esta vacio" });
  }
  if (!shippingAddress || typeof shippingAddress !== "object") {
    return res.status(400).json({ error: "Falta direccion de envio" });
  }

  const fullName = String(shippingAddress.fullName || "").trim();
  const address = String(shippingAddress.address || "").trim();
  const city = String(shippingAddress.city || "").trim();
  const phone = String(shippingAddress.phone || "").trim();

  const normalizedShippingCost = Number(shippingCost ?? shipping ?? 0);

  if (fullName.length < 4 || address.length < 6 || city.length < 2) {
    return res.status(400).json({ error: "Direccion de envio invalida" });
  }
  if (!Number.isFinite(normalizedShippingCost) || normalizedShippingCost < 0 || normalizedShippingCost > 50000) {
    return res.status(400).json({ error: "Costo de envio invalido" });
  }

  const products = readJson("products.json");
  const normalizedItems = [];

  for (const item of items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product) {
      return res.status(400).json({ error: `Producto no valido: ${item.productId}` });
    }

    const qty = Number(item.qty || 0);
    if (qty <= 0) {
      return res.status(400).json({ error: `Cantidad invalida: ${item.productId}` });
    }

    normalizedItems.push({
      productId: product.id,
      title: product.name,
      unitPrice: Number(product.price),
      qty
    });
  }

  const itemsTotal = normalizedItems.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const grandTotal = itemsTotal + normalizedShippingCost;

  const order = {
    id: `OW-${Date.now()}`,
    userId: req.user.userId,
    userEmail: req.user.email,
    status: "pending",
    items: normalizedItems,
    shippingCost: normalizedShippingCost,
    shippingAddress: { fullName, address, city, phone },
    total: grandTotal,
    createdAt: new Date().toISOString(),
    mpPreferenceId: null,
    mpPaymentId: null
  };

  const orders = readJson("orders.json");
  orders.push(order);
  writeJson("orders.json", orders);

  if (!mpClient) {
    return res.status(503).json({
      error: "Mercado Pago no configurado",
      detail: "Configura MERCADOPAGO_ACCESS_TOKEN en backend/.env"
    });
  }

  try {
    const preference = new Preference(mpClient);

    const mpItems = normalizedItems.map((item) => ({
      id: item.productId,
      title: item.title,
      quantity: item.qty,
      currency_id: "ARS",
      unit_price: item.unitPrice
    }));

    if (normalizedShippingCost > 0) {
      mpItems.push({
        id: "envio-ow",
        title: "Costo de Envio",
        quantity: 1,
        currency_id: "ARS",
        unit_price: normalizedShippingCost
      });
    }

    const response = await preference.create({
      body: {
        items: mpItems,
        payer: { email: req.user.email },
        back_urls: {
          success: `${frontendUrls[0] || "http://localhost:5500"}/index.html?payment=success`,
          failure: `${frontendUrls[0] || "http://localhost:5500"}/index.html?payment=failure`,
          pending: `${frontendUrls[0] || "http://localhost:5500"}/index.html?payment=pending`
        },
        auto_return: "approved",
        notification_url: process.env.MERCADOPAGO_WEBHOOK_URL,
        external_reference: order.id
      }
    });

    const updatedOrders = readJson("orders.json");
    const idx = updatedOrders.findIndex((o) => o.id === order.id);
    if (idx >= 0) {
      updatedOrders[idx].mpPreferenceId = response.id;
      writeJson("orders.json", updatedOrders);
    }

    return res.json({
      orderId: order.id,
      initPoint: response.init_point,
      sandboxInitPoint: response.sandbox_init_point
    });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo crear preferencia", detail: error.message });
  }
});
