const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { state, save } = require("./db");
const { sendMail } = require("./mailer");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const FREE_SUBSCRIPTION_DAYS = 365;
const FREE_TUTOR_LIMIT = 100; // أول 100 معلم/معلمة بياخدوا سنة مجانية أوتوماتيك

// فحص تكرار البيانات على مستوى المنصة كلها (مدرسين + مراكز + أولياء أمور + طلاب) مش بس داخل نفس النوع
function phoneTaken(phone, excludeId, excludeKind) {
  return (
    state.providers.some((p) => p.phone === phone && !(excludeKind === "provider" && p.id === excludeId)) ||
    state.seekers.some((s) => s.phone === phone && !(excludeKind === "seeker" && s.id === excludeId))
  );
}
function emailTaken(email, excludeId, excludeKind) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  return (
    state.providers.some((p) => p.email && p.email.toLowerCase() === e && !(excludeKind === "provider" && p.id === excludeId)) ||
    state.seekers.some((s) => s.email && s.email.toLowerCase() === e && !(excludeKind === "seeker" && s.id === excludeId))
  );
}
function nationalIdTaken(nid, excludeId, excludeKind) {
  if (!nid) return false;
  return (
    state.providers.some((p) => p.national_id && p.national_id === nid && !(excludeKind === "provider" && p.id === excludeId)) ||
    state.seekers.some((s) => s.national_id && s.national_id === nid && !(excludeKind === "seeker" && s.id === excludeId))
  );
}
function usernameTaken(username, excludeId, excludeKind) {
  if (!username) return false;
  const u = String(username).toLowerCase();
  return (
    state.providers.some((p) => p.username && p.username.toLowerCase() === u && !(excludeKind === "provider" && p.id === excludeId)) ||
    state.seekers.some((s) => s.username && s.username.toLowerCase() === u && !(excludeKind === "seeker" && s.id === excludeId))
  );
}

// إنشاء حساب سوبر أدمن افتراضي أول مرة (لو مفيش حساب سوبر أدمن محفوظ خالص)
if (state.admins.length === 0) {
  const seedUsername = process.env.SUPER_ADMIN_USERNAME || "01030422228";
  const seedPassword = process.env.SUPER_ADMIN_PASSWORD || "admin0115302197";
  state.admins.push({
    username: seedUsername,
    password_hash: bcrypt.hashSync(seedPassword, 10),
    created_at: new Date().toISOString(),
  });
  save();
}

// العرض المجاني: أول 100 معلمة وأول 100 معلم (كوتا منفصلة لكل نوع)
function freeTutorSlotsUsed(gender) {
  return state.providers.filter((x) => x.type === "tutor" && x.gender === gender && x.subscription_start).length;
}

function subscriptionInfo(p) {
  const now = Date.now();
  const end = p.subscription_end ? new Date(p.subscription_end).getTime() : null;
  const expired = end ? now > end : false;
  const daysLeft = end ? Math.max(0, Math.ceil((end - now) / 86400000)) : null;
  return {
    subscription_start: p.subscription_start || null,
    subscription_end: p.subscription_end || null,
    active: p.active !== false,
    expired,
    days_left: daysLeft,
  };
}
function stripPrivate(p) {
  const { password_hash, national_id, ...rest } = p;
  return { ...rest, ...subscriptionInfo(p) };
}
function stripPrivateSeeker(s) {
  const { password_hash, national_id, ...rest } = s;
  return { ...rest, active: s.active !== false };
}
function isLive(p) {
  const now = Date.now();
  const end = p.subscription_end ? new Date(p.subscription_end).getTime() : null;
  return p.active !== false && (!end || now <= end);
}

function ratingOf(providerId) {
  const rs = state.reviews.filter((r) => r.provider_id === providerId);
  const cnt = rs.length;
  const avg = cnt ? rs.reduce((a, r) => a + r.rating, 0) / cnt : 0;
  return { rating: Math.round(avg * 10) / 10, reviewCount: cnt };
}
function withRating(p) {
  return { ...stripPrivate(p), ...ratingOf(p.id) };
}

// ترتيب النتائج: تقييم موزون (بايزي، عشان معلم بتقييم 5 من مرة واحدة متطلعش فوق معلم بمتوسط 4.7 من 50 تقييم)
// + أولوية بسيطة لنفس محافظة الباحث + بونص بسيط للنشاط الأخير (آخر دخول)
const RATING_MIN_VOTES = 5; // m
function globalAverageRating() {
  if (!state.reviews.length) return 4.3; // متوسط افتراضي معقول لحد ما يكون فيه تقييمات كفاية
  return state.reviews.reduce((a, r) => a + r.rating, 0) / state.reviews.length;
}
function weightedRating(rating, reviewCount) {
  const C = globalAverageRating();
  const v = reviewCount, m = RATING_MIN_VOTES;
  return (v / (v + m)) * rating + (m / (v + m)) * C;
}
function recencyBonus(lastLoginIso) {
  if (!lastLoginIso) return 0;
  const days = (Date.now() - new Date(lastLoginIso).getTime()) / 86400000;
  if (days <= 3) return 0.3;
  if (days <= 14) return 0.15;
  if (days <= 30) return 0.05;
  return 0;
}
function searchScore(p, effectiveArea) {
  const wr = weightedRating(p.rating, p.reviewCount);
  const areaBonus = effectiveArea && p.area && p.area === effectiveArea ? 0.5 : 0;
  return wr + areaBonus + recencyBonus(p.last_login);
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- providers (tutors + centers): public search ----------
app.get("/api/providers", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  const country = (req.query.country || "").trim();
  const mode = (req.query.mode || "").trim(); // online | in_person | both
  const groupType = (req.query.group_type || "").trim(); // individual | group
  const type = (req.query.type || "").trim(); // tutor | center
  const stage = (req.query.stage || "").trim();
  const areaFilter = (req.query.area || "").trim();
  const seekerId = parseInt(req.query.seeker_id, 10);

  let rows = state.providers.filter((p) => p.status === "approved" && isLive(p)).map(withRating);

  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((p) => {
      const hay = `${p.name} ${p.subject} ${p.stage} ${p.country} ${p.area}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  if (stage) rows = rows.filter((p) => p.stage === stage);
  if (country) rows = rows.filter((p) => p.country === country);
  if (mode) rows = rows.filter((p) => p.mode === mode || p.mode === "both");
  if (groupType) rows = rows.filter((p) => p.group_type === groupType);
  if (type) rows = rows.filter((p) => p.type === type);

  // القرب الجغرافي: لو محدد محافظة فلتر بيها، أو استنتجها من محافظة الباحث المسجل دخوله
  let effectiveArea = areaFilter;
  if (!effectiveArea && seekerId) {
    const seeker = state.seekers.find((s) => s.id === seekerId);
    if (seeker) effectiveArea = seeker.area || "";
  }

  rows.sort((a, b) => searchScore(b, effectiveArea) - searchScore(a, effectiveArea) || b.reviewCount - a.reviewCount);
  res.json(rows);
});

// ---------- provider detail (+ contact reveal gated by seeker_id) ----------
app.get("/api/providers/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id && x.status === "approved" && isLive(x));
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const full = withRating(p);
  const reviews = state.reviews
    .filter((r) => r.provider_id === id)
    .sort((a, b) => b.id - a.id)
    .map(({ seeker_name, rating, text, created_at }) => ({ seeker_name, rating, text, created_at }));

  let phone = null;
  let can_review = false;
  const seekerId = parseInt(req.query.seeker_id, 10);
  if (seekerId && state.seekers.some((s) => s.id === seekerId)) {
    phone = p.phone;
    const hasConfirmedBooking = state.bookings.some((b) => b.provider_id === id && b.seeker_id === seekerId && b.status === "confirmed");
    const alreadyReviewed = state.reviews.some((r) => r.provider_id === id && r.seeker_id === seekerId);
    can_review = hasConfirmedBooking && !alreadyReviewed;
  }

  res.json({ ...full, phone, can_review, reviews });
});

// ---------- provider registration (tutor أو center) - pending review ----------
app.post("/api/providers", (req, res) => {
  const {
    type, gender, name, username, phone, email, national_id, country, area, nationality, dob,
    stage, subject, degree, experience_years, mode, group_type, max_students,
    price, payment_method, bio, availability_days, availability_from, availability_to,
    password,
  } = req.body || {};

  if (!["tutor", "center"].includes(type)) {
    return res.status(400).json({ error: "نوع الحساب لازم يكون مدرس أو مركز تعليمي" });
  }
  if (type === "tutor" && !["male", "female"].includes(gender)) {
    return res.status(400).json({ error: "النوع (معلم/معلمة) مطلوب" });
  }
  if (!name || !phone || !email || !national_id || !country || !nationality || !dob || !subject || !price) {
    return res.status(400).json({ error: "البيانات الأساسية (الاسم، الهاتف، الإيميل، الرقم القومي/المدني، الدولة، الجنسية، تاريخ الميلاد، التخصص، السعر) مطلوبة" });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "كلمة السر مطلوبة ولازم تكون 6 حروف/أرقام على الأقل" });
  }
  if (phoneTaken(phone)) {
    return res.status(409).json({ error: "رقم الهاتف ده مسجل بالفعل بحساب تاني على المنصة" });
  }
  if (emailTaken(email)) {
    return res.status(409).json({ error: "البريد الإلكتروني ده مسجل بالفعل بحساب تاني على المنصة" });
  }
  if (nationalIdTaken(national_id)) {
    return res.status(409).json({ error: "الرقم القومي/المدني ده مسجل بالفعل بحساب تاني على المنصة" });
  }
  if (usernameTaken(username)) {
    return res.status(409).json({ error: "اسم المستخدم ده مستخدم بالفعل" });
  }
  if (!["online", "in_person", "both"].includes(mode)) {
    return res.status(400).json({ error: "طريقة التدريس لازم تكون أونلاين أو حضوري أو الاثنين" });
  }
  if (!["individual", "group"].includes(group_type)) {
    return res.status(400).json({ error: "نوع الدرس لازم يكون فردي أو مجموعة" });
  }
  if (!["transfer", "cash"].includes(payment_method)) {
    return res.status(400).json({ error: "طريقة الدفع لازم تكون تحويل أو نقدي" });
  }

  const p = {
    id: state.nextIds.provider++,
    type, gender: type === "tutor" ? gender : "", name, username: username || "", phone, email, national_id,
    country, area: area || "", nationality, dob,
    stage: stage || "", subject, degree: degree || "", experience_years: parseInt(experience_years, 10) || 0,
    mode, group_type, max_students: group_type === "group" ? (parseInt(max_students, 10) || 2) : 1,
    price: parseFloat(price) || 0, payment_method, bio: bio || "",
    availability_days: Array.isArray(availability_days) ? availability_days : [],
    availability_from: availability_from || "", availability_to: availability_to || "",
    password_hash: bcrypt.hashSync(String(password), 10),
    subscription_start: null, subscription_end: null, active: true,
    status: "pending", created_at: new Date().toISOString(),
  };
  state.providers.push(p);
  save();
  res.status(201).json({ id: p.id, status: "pending" });
});

// ---------- provider self dashboard ----------
app.get("/api/providers/:id/me", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  res.json(stripPrivate(p));
});
app.get("/api/providers/:id/bookings", (req, res) => {
  const provider_id = parseInt(req.params.id, 10);
  const rows = state.bookings
    .filter((b) => b.provider_id === provider_id)
    .sort((a, b) => b.id - a.id)
    .map((b) => {
      const s = state.seekers.find((x) => x.id === b.seeker_id) || {};
      return { id: b.id, seeker_id: b.seeker_id, status: b.status, status_label: bookingStatusLabel(b.status), created_at: b.created_at, seeker_name: s.name, seeker_phone: s.phone };
    });
  res.json(rows);
});

// ---------- seeker public profile (بروفايل عام لولي الأمر/الطالب - يظهر بس للمدرس اللي عنده حجز معاه) ----------
app.get("/api/seekers/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (!s) return res.status(404).json({ error: "غير موجود" });
  const providerId = parseInt(req.query.provider_id, 10);
  let phone = null;
  if (providerId && state.bookings.some((b) => b.provider_id === providerId && b.seeker_id === id)) {
    phone = s.phone;
  }
  res.json({
    id: s.id, name: s.name, type: s.type,
    country: s.country, area: s.area || "",
    children_count: s.type === "parent" ? s.children_count : undefined,
    member_since: s.created_at,
    phone,
  });
});

// ---------- reviews (مقفولة على حجز مؤكد فقط عشان تكون التقييمات موثوقة) ----------
app.post("/api/providers/:id/reviews", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const { seeker_id, rating, text } = req.body || {};
  const seekerId = parseInt(seeker_id, 10);
  const seeker = state.seekers.find((s) => s.id === seekerId);
  if (!seeker) return res.status(401).json({ error: "لازم تسجّل دخولك كولي أمر أو طالب الأول عشان تقيّم" });
  const hasConfirmedBooking = state.bookings.some((b) => b.provider_id === id && b.seeker_id === seekerId && b.status === "confirmed");
  if (!hasConfirmedBooking) return res.status(403).json({ error: "التقييم متاح بس بعد ما المدرس يأكد حجزك معاه" });
  if (state.reviews.some((r) => r.provider_id === id && r.seeker_id === seekerId)) {
    return res.status(409).json({ error: "أنت قيّمت المدرس ده قبل كده" });
  }
  const r = parseInt(rating, 10);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: "التقييم لازم يكون من 1 لـ 5" });
  state.reviews.push({
    id: state.nextIds.review++, provider_id: id, seeker_id: seekerId,
    seeker_name: seeker.name, rating: r, text: text || "(بدون تعليق)",
    created_at: new Date().toISOString(),
  });
  save();
  res.status(201).json({ ok: true });
});

// ---------- seekers (parent أو student) ----------
app.post("/api/seekers", (req, res) => {
  const { type, name, username, phone, email, national_id, country, area, nationality, dob, children_count, password } = req.body || {};
  if (!["parent", "student"].includes(type)) {
    return res.status(400).json({ error: "نوع الحساب لازم يكون ولي أمر أو طالب" });
  }
  if (!name || !phone || !national_id || !country || !nationality || !dob) {
    return res.status(400).json({ error: "الاسم والهاتف والرقم القومي/المدني والدولة والجنسية وتاريخ الميلاد مطلوبة" });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "كلمة السر مطلوبة ولازم تكون 6 حروف/أرقام على الأقل" });
  }
  if (phoneTaken(phone)) {
    return res.status(409).json({ error: "رقم الهاتف ده مسجل بالفعل بحساب تاني على المنصة" });
  }
  if (emailTaken(email)) {
    return res.status(409).json({ error: "البريد الإلكتروني ده مسجل بالفعل بحساب تاني على المنصة" });
  }
  if (nationalIdTaken(national_id)) {
    return res.status(409).json({ error: "الرقم القومي/المدني ده مسجل بالفعل بحساب تاني على المنصة" });
  }
  if (usernameTaken(username)) {
    return res.status(409).json({ error: "اسم المستخدم ده مستخدم بالفعل" });
  }
  const s = {
    id: state.nextIds.seeker++, type, name, username: username || "", phone,
    email: email || "", national_id, country, area: area || "", nationality, dob,
    children_count: type === "parent" ? (parseInt(children_count, 10) || 0) : 0,
    password_hash: bcrypt.hashSync(String(password), 10),
    active: true,
    created_at: new Date().toISOString(),
  };
  state.seekers.push(s);
  save();
  res.status(201).json(stripPrivateSeeker(s));
});

// ---------- unified login (provider أو seeker) ----------
app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "رقم الهاتف وكلمة السر مطلوبان" });
  const p = state.providers.find((x) => x.phone === phone);
  if (p && bcrypt.compareSync(String(password), p.password_hash)) {
    if (p.active === false) return res.status(403).json({ error: "الحساب موقوف حاليًا من الإدارة" });
    p.last_login = new Date().toISOString();
    save();
    return res.json({ kind: "provider", ...stripPrivate(p) });
  }
  const s = state.seekers.find((x) => x.phone === phone);
  if (s && bcrypt.compareSync(String(password), s.password_hash)) {
    if (s.active === false) return res.status(403).json({ error: "الحساب موقوف حاليًا من الإدارة" });
    return res.json({ kind: "seeker", ...stripPrivateSeeker(s) });
  }
  res.status(401).json({ error: "رقم الهاتف أو كلمة السر غلط" });
});

// نسيت كلمة السر: بعتلك كلمة سر جديدة على الإيميل المسجل (لو موجود) - نفس الرد دايمًا عشان محدش يعرف مين مسجل
app.post("/api/forgot-password", async (req, res) => {
  const generic = { ok: true, message: "لو رقم الهاتف ده مسجل وعنده إيميل، هيوصله كلمة سر جديدة على الإيميل خلال دقايق" };
  const { phone } = req.body || {};
  if (!phone) return res.json(generic);
  const account = state.providers.find((x) => x.phone === phone) || state.seekers.find((x) => x.phone === phone);
  if (!account || !account.email) return res.json(generic);
  const newPassword = crypto.randomBytes(4).toString("hex");
  account.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  try {
    await sendMail({
      to: account.email,
      subject: "كلمة السر الجديدة - منصة نجاح",
      text: `أهلًا ${account.name}،\n\nطلبت استرجاع كلمة السر لحسابك على منصة نجاح.\nكلمة السر الجديدة هي: ${newPassword}\n\nتقدر تسجّل دخولك بيها دلوقتي.\n\nمنصة نجاح`,
    });
  } catch (e) {
    console.error("فشل إرسال إيميل استرجاع كلمة السر:", e.message);
  }
  res.json(generic);
});

// ---------- تذاكر الشكاوى/التواصل مع الإدارة (لكل أنواع الحسابات: مدرس/معلمة/مركز/ولي أمر/طالب) ----------
app.post("/api/tickets", async (req, res) => {
  const { author_kind, author_id, subject, message } = req.body || {};
  if (!["provider", "seeker"].includes(author_kind)) {
    return res.status(400).json({ error: "نوع الحساب غير معروف" });
  }
  const authorId = parseInt(author_id, 10);
  const author = author_kind === "provider"
    ? state.providers.find((p) => p.id === authorId)
    : state.seekers.find((s) => s.id === authorId);
  if (!author) return res.status(401).json({ error: "لازم تسجّل دخولك الأول عشان تفتح تذكرة" });
  if (!subject || !message) return res.status(400).json({ error: "الموضوع والرسالة مطلوبين" });

  const t = {
    id: state.nextIds.ticket++,
    author_kind, author_id: authorId,
    author_name: author.name, author_phone: author.phone,
    author_type: author.type, // tutor|center|parent|student
    subject: String(subject).slice(0, 200), message: String(message).slice(0, 3000),
    status: "open", admin_reply: "",
    created_at: new Date().toISOString(),
  };
  state.tickets.push(t);
  save();

  if (process.env.ADMIN_NOTIFY_EMAIL) {
    try {
      await sendMail({
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `تذكرة جديدة من ${author.name} - نجاح`,
        text: `نوع الحساب: ${t.author_type}\nالاسم: ${t.author_name}\nالهاتف: ${t.author_phone}\nالموضوع: ${t.subject}\n\nالرسالة:\n${t.message}`,
      });
    } catch (e) {
      console.error("فشل إرسال إشعار تذكرة للإدارة:", e.message);
    }
  }
  res.status(201).json({ id: t.id, status: "open" });
});
app.get("/api/tickets", (req, res) => {
  const authorKind = req.query.author_kind;
  const authorId = parseInt(req.query.author_id, 10);
  if (!["provider", "seeker"].includes(authorKind) || !authorId) return res.json([]);
  const rows = state.tickets
    .filter((t) => t.author_kind === authorKind && t.author_id === authorId)
    .sort((a, b) => b.id - a.id);
  res.json(rows);
});
app.get("/api/admin/tickets", requireAdmin, (req, res) => {
  const status = req.query.status || "";
  let rows = state.tickets.slice().sort((a, b) => b.id - a.id);
  if (status) rows = rows.filter((t) => t.status === status);
  res.json(rows);
});
app.post("/api/admin/tickets/:id/resolve", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = state.tickets.find((x) => x.id === id);
  if (!t) return res.status(404).json({ error: "غير موجود" });
  t.status = "resolved";
  t.admin_reply = req.body && req.body.admin_reply ? String(req.body.admin_reply).slice(0, 3000) : t.admin_reply;
  save();
  res.json({ ok: true });
});

// ---------- favorites ----------
app.post("/api/seekers/:sid/favorites/:pid", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const provider_id = parseInt(req.params.pid, 10);
  if (!state.favorites.some((f) => f.seeker_id === seeker_id && f.provider_id === provider_id)) {
    state.favorites.push({ seeker_id, provider_id });
    save();
  }
  res.json({ ok: true });
});
app.delete("/api/seekers/:sid/favorites/:pid", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const provider_id = parseInt(req.params.pid, 10);
  state.favorites = state.favorites.filter((f) => !(f.seeker_id === seeker_id && f.provider_id === provider_id));
  save();
  res.json({ ok: true });
});
app.get("/api/seekers/:sid/favorites", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const providerIds = state.favorites.filter((f) => f.seeker_id === seeker_id).map((f) => f.provider_id);
  const rows = state.providers.filter((p) => providerIds.includes(p.id) && p.status === "approved").map(withRating);
  res.json(rows);
});

// ---------- bookings ----------
app.post("/api/bookings", (req, res) => {
  const provider_id = parseInt(req.body.provider_id, 10);
  const seeker_id = parseInt(req.body.seeker_id, 10);
  const provider = state.providers.find((p) => p.id === provider_id && p.status === "approved");
  const seeker = state.seekers.find((s) => s.id === seeker_id);
  if (!provider || !seeker) return res.status(400).json({ error: "بيانات الحجز غير صحيحة" });
  const b = { id: state.nextIds.booking++, provider_id, seeker_id, status: "pending", created_at: new Date().toISOString() };
  state.bookings.push(b);
  save();
  res.status(201).json({ id: b.id });
});
function bookingStatusLabel(status) {
  return status === "confirmed" ? "✅ تم تأكيد الحجز" : status === "cancelled" ? "❌ ملغي" : "⏳ بانتظار تأكيد المدرس";
}
// المدرس/المركز بيأكد أو يلغي طلب الحجز - التأكيد هو اللي بيفتح الباب لولي الأمر/الطالب عشان يقيّم بعد كده
app.post("/api/bookings/:id/confirm", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const providerId = parseInt(req.body.provider_id, 10);
  const b = state.bookings.find((x) => x.id === id && x.provider_id === providerId);
  if (!b) return res.status(404).json({ error: "غير موجود" });
  b.status = "confirmed";
  save();
  res.json({ ok: true });
});
app.post("/api/bookings/:id/cancel", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const providerId = parseInt(req.body.provider_id, 10);
  const b = state.bookings.find((x) => x.id === id && x.provider_id === providerId);
  if (!b) return res.status(404).json({ error: "غير موجود" });
  b.status = "cancelled";
  save();
  res.json({ ok: true });
});
app.get("/api/seekers/:sid/bookings", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const rows = state.bookings
    .filter((b) => b.seeker_id === seeker_id)
    .sort((a, b) => b.id - a.id)
    .map((b) => {
      const p = state.providers.find((x) => x.id === b.provider_id) || {};
      const reviewed = state.reviews.some((r) => r.provider_id === b.provider_id && r.seeker_id === seeker_id);
      const needs_review = b.status === "confirmed" && !reviewed;
      return { id: b.id, provider_id: b.provider_id, status: b.status, status_label: bookingStatusLabel(b.status), created_at: b.created_at, provider_name: p.name, subject: p.subject, price: p.price, needs_review };
    });
  res.json(rows);
});

// ---------- admin ----------
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "غير مصرح" });
  next();
}
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const admin = state.admins.find((a) => a.username === username);
  if (!admin || !bcrypt.compareSync(password || "", admin.password_hash)) {
    return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  }
  res.json({ ok: true, username: admin.username, admin_key: ADMIN_KEY });
});
app.post("/api/admin/change-password", requireAdmin, (req, res) => {
  const { username, new_password } = req.body || {};
  const admin = state.admins.find((a) => a.username === username);
  if (!admin) return res.status(404).json({ error: "الحساب غير موجود" });
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: "كلمة السر لازم تكون 6 حروف/أرقام على الأقل" });
  admin.password_hash = bcrypt.hashSync(new_password, 10);
  save();
  res.json({ ok: true });
});
app.get("/api/admin/providers", requireAdmin, (req, res) => {
  const status = req.query.status || "pending";
  const rows = state.providers.filter((p) => p.status === status).sort((a, b) => b.id - a.id)
    .map((p) => ({ ...stripPrivate(p), national_id: p.national_id || "" }));
  res.json(rows);
});
app.post("/api/admin/providers/:id/approve", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) {
    p.status = "approved";
    let gotFreeYear = false;
    if (!p.subscription_start) {
      if (p.type === "center" || (p.type === "tutor" && freeTutorSlotsUsed(p.gender) < FREE_TUTOR_LIMIT)) {
        p.subscription_start = new Date().toISOString();
        p.subscription_end = new Date(Date.now() + FREE_SUBSCRIPTION_DAYS * 86400000).toISOString();
        gotFreeYear = true;
      }
    }
    p.active = true;
    save();
    return res.json({ ok: true, got_free_year: gotFreeYear });
  }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/set-subscription", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const months = parseInt(req.body.months, 10);
  if (!months || months < 1) return res.status(400).json({ error: "عدد الشهور غير صحيح" });
  p.subscription_start = new Date().toISOString();
  p.subscription_end = new Date(Date.now() + months * 30 * 86400000).toISOString();
  p.active = true;
  save();
  res.json({ ok: true, subscription_end: p.subscription_end });
});
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const usedFemale = freeTutorSlotsUsed("female");
  const usedMale = freeTutorSlotsUsed("male");
  res.json({
    free_tutor_limit: FREE_TUTOR_LIMIT,
    female_slots_used: usedFemale,
    female_slots_left: Math.max(0, FREE_TUTOR_LIMIT - usedFemale),
    male_slots_used: usedMale,
    male_slots_left: Math.max(0, FREE_TUTOR_LIMIT - usedMale),
  });
});
app.post("/api/admin/providers/:id/suspend", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) { p.active = false; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/activate", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) { p.active = true; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/reset-password", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const newPassword = crypto.randomBytes(4).toString("hex"); // 8 حروف
  p.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  res.json({ ok: true, new_password: newPassword });
});
app.post("/api/admin/providers/:id/reject", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) { p.status = "rejected"; save(); }
  res.json({ ok: true });
});
app.delete("/api/admin/providers/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  state.providers = state.providers.filter((x) => x.id !== id);
  state.reviews = state.reviews.filter((r) => r.provider_id !== id);
  state.bookings = state.bookings.filter((b) => b.provider_id !== id);
  state.favorites = state.favorites.filter((f) => f.provider_id !== id);
  save();
  res.json({ ok: true });
});

// ---------- admin: seekers (أولياء الأمور والطلاب) ----------
app.get("/api/admin/seekers", requireAdmin, (req, res) => {
  const type = req.query.type || "";
  let rows = state.seekers.slice().sort((a, b) => b.id - a.id);
  if (type) rows = rows.filter((s) => s.type === type);
  res.json(rows.map((s) => ({ ...stripPrivateSeeker(s), national_id: s.national_id || "" })));
});
app.post("/api/admin/seekers/:id/suspend", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (s) { s.active = false; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/seekers/:id/activate", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (s) { s.active = true; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/seekers/:id/reset-password", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (!s) return res.status(404).json({ error: "غير موجود" });
  const newPassword = crypto.randomBytes(4).toString("hex");
  s.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  res.json({ ok: true, new_password: newPassword });
});
app.delete("/api/admin/seekers/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  state.seekers = state.seekers.filter((x) => x.id !== id);
  state.bookings = state.bookings.filter((b) => b.seeker_id !== id);
  state.favorites = state.favorites.filter((f) => f.seeker_id !== id);
  save();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`نجاح (Nagah) platform running on port ${PORT}`));
