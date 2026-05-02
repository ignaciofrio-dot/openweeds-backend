import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import mongoose from "mongoose"; //
import { readJson } from "./storage.js"; 
import { createToken, requireAuth } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const adminKey = process.env.ADMIN_KEY;
const mongoURI = process.env.MONGO_URI; //[cite: 1]

// --- CONEXIÓN A MONGO DB ---
mongoose.connect(mongoURI)
  .then(() => console.log("Conectado a MongoDB Atlas con éxito"))
  .catch(err => console.error("Error al conectar a MongoDB:", err)); //[cite: 1]

// --- ESQUEMAS DE DATOS ---
const userSchema = new mongoose.Schema({
  id: String,
  email: { type: String, unique: true },
  passwordHash: String,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema); //[cite: 1]

const orderSchema = new mongoose.Schema({
  id: String,
  userId: String,
  userEmail: String,
  status: String,
  items: Array,
  shippingCost: Number,
  shippingAddress: Object,
  total: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  mpPreferenceId: String,
  mpPaymentId: String
});
const Order = mongoose.model("Order", orderSchema); //[cite: 1]

if (!process.env.JWT_SECRET) {
  throw new Error("Falta JWT_SECRET en .env");
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (frontendUrls.length === 0 || frontendUrls.includes(origin)) return callback(null, true);
    return callback(new Error("Origen no permitido por CORS"));
  },
  credentials: false
}));
app.use(express.json());
app.disable("x-powered-by");

let mpClient = null;
if (mpAccessToken) {
  mpClient = new MercadoPagoConfig({ accessToken: mpAccessToken });
}

// Rutas básicas
app.get("/api/health", (_req, res) => res.json({ ok: true, database: "mongodb" }));

app.get("/api/products", (_req, res) => {
  const products = readJson("products.json");
  res.json(products);
});

// --- AUTH CON MONGO ---
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) return res.status(400).json({ error: "Datos inválidos" });

  try {
    const exists = await User.findOne({ email: email.toLowerCase() }); //[cite: 1]
    if (exists) return res.status(409).json({ error: "El usuario ya existe" });

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = new User({ id: uuidv4(), email: email.toLowerCase(), passwordHash });
    await newUser.save(); //[cite: 1]

    const token = createToken(newUser);
    return res.status(201).json({ token, user: { id: newUser.id, email: newUser.email } });
  } catch (err) {
    res.status(500).json({ error: "Error en registro" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email.toLowerCase() }); //[cite: 1]
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }
  const token = createToken(user);
  return res.json({ token, user: { id: user.id, email: user.email } });
});

// --- CHECKOUT CON MONGO ---
app.post("/api/orders/checkout", requireAuth, async (req, res) => {
  const { items, shipping, shippingAddress } = req.body;
  const products = readJson("products.json");
  
  const normalizedItems = items.map(item => {
    const p = products.find(prod => prod.id === item.productId);
    return { productId: p.id, title: p.name, unitPrice: Number(p.price), qty: Number(item.qty) };
  });

  const itemsTotal = normalizedItems.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const shippingCost = Number(shipping || 0);

  const orderData = {
    id: `OW-${Date.now()}`,
    userId: req.user.userId,
    userEmail: req.user.email,
    status: "pending",
    items: normalizedItems,
    shippingCost,
    shippingAddress,
    total: itemsTotal + shippingCost
  };

  try {
    const newOrder = new Order(orderData);
    await newOrder.save(); //[cite: 1]

    if (!mpClient) return res.status(503).json({ error: "MP no configurado" });

    const preference = new Preference(mpClient);
    const response = await preference.create({
      body: {
        items: normalizedItems.map(i => ({ title: i.title, quantity: i.qty, unit_price: i.unitPrice, currency_id: "ARS" })),
        external_reference: orderData.id,
        back_urls: {
          success: `${frontendUrls[0]}/index.html?payment=success`,
          failure: `${frontendUrls[0]}/index.html?payment=failure`
        },
        auto_return: "approved",
      }
    });

    await Order.findOneAndUpdate({ id: orderData.id }, { mpPreferenceId: response.id }); //[cite: 1]
    return res.json({ orderId: orderData.id, initPoint: response.init_point });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- WEBHOOK ACTUALIZADO ---
app.post("/api/payments/webhook", async (req, res) => {
  try {
    const paymentId = req.query["data.id"] || req.body?.data?.id;
    if (!mpClient || !paymentId) return res.sendStatus(200);

    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: paymentId });
    
    await Order.findOneAndUpdate( //[cite: 1]
      { id: payment.external_reference },
      { 
        status: payment.status === "approved" ? "paid" : "rejected",
        mpPaymentId: String(paymentId),
        updatedAt: new Date()
      }
    );
    return res.sendStatus(200);
  } catch (error) {
    return res.sendStatus(200);
  }
});

// --- ADMIN VIEW ---
app.get("/api/admin/orders-view", async (req, res) => {
  const key = req.query.key;
  if (!adminKey || key !== adminKey) return res.status(401).json({ error: "No autorizado" });

  const ready =
    mongoose.connection.readyState === 1; /** 1 = connected */
  if (!mongoURI) {
    return res.status(503).json({
      error: "Mongo sin configurar",
      detail: "Falta variable MONGO_URI en Render",
    });
  }
  if (!ready) {
    return res.status(503).json({
      error: "Base de datos no conectada",
      detail:
        mongoURI.startsWith("mongodb")
          ? "Revisá MONGO_URI, IP allowlist en Atlas y que el servicio haya iniciado tras el deploy."
          : "Formato de MONGO_URI inválido o conexión aún en curso; probá de nuevo en unos segundos.",
    });
  }

  try {
    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .lean();
    const payload = orders.map((o) => ({
      ...o,
      id: o.id ?? (o._id != null ? String(o._id) : undefined),
    }));
    res.json({ count: payload.length, orders: payload });
  } catch (error) {
    console.error("[orders-view]", error);
    res.status(500).json({
      error: "Error al obtener pedidos",
      detail: error?.message || String(error),
    });
  }
});

app.listen(port, () => console.log(`API lista con MongoDB en puerto ${port}`));
