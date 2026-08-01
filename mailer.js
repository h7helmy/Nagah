// إرسال إيميلات بسيط عن طريق حساب Gmail مخصص للمنصة (مجاني - App Password)
const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.log("[mailer] GMAIL_USER/GMAIL_APP_PASSWORD مش متظبطين - هتم تجاهل الإرسال. كان هيتبعت:", { to, subject, text });
    return { sent: false };
  }
  await t.sendMail({ from: `"نجاح" <${process.env.GMAIL_USER}>`, to, subject, text });
  return { sent: true };
}

module.exports = { sendMail };
