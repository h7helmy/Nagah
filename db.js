// مخزن بيانات بسيط قائم على ملف JSON (بدون اعتماديات native) - مناسب لنموذج MVP حقيقي
const fs = require("fs");
const path = require("path");

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, "data.json");

function seedData() {
  return {
    nextIds: { tutor: 8, parent: 1, review: 6, booking: 1 },
    tutors: [
      { id: 1, name: "أ. أحمد فتحي", subject: "رياضيات", stage: "ثانوي", area: "مدينة نصر", price: 180, bio: "مدرس رياضيات بخبرة 12 عامًا، بكالوريوس علوم رياضيات - جامعة عين شمس.", phone: "01012345678", status: "approved", created_at: new Date().toISOString() },
      { id: 2, name: "أ. سارة حسين", subject: "لغة إنجليزية", stage: "إعدادي", area: "مصر الجديدة", price: 150, bio: "مدرسة لغة إنجليزية، دبلوم TEFL، متخصصة في المحادثة والقواعد.", phone: "01098765432", status: "approved", created_at: new Date().toISOString() },
      { id: 3, name: "أ. محمود عادل", subject: "فيزياء", stage: "ثانوي", area: "المهندسين", price: 200, bio: "مدرس فيزياء لمراحل الثانوية العامة، خبرة 8 سنوات.", phone: "01011122233", status: "approved", created_at: new Date().toISOString() },
      { id: 4, name: "أ. هبة الله ياسر", subject: "لغة عربية", stage: "ابتدائي", area: "مدينة نصر", price: 120, bio: "مدرسة لغة عربية للمرحلة الابتدائية، أسلوب مبسط وممتع.", phone: "01055566677", status: "approved", created_at: new Date().toISOString() },
      { id: 5, name: "أ. عمر خالد", subject: "كيمياء", stage: "ثانوي", area: "الشيخ زايد", price: 190, bio: "مدرس كيمياء، ماجستير في التربية الكيميائية.", phone: "01022233344", status: "approved", created_at: new Date().toISOString() },
      { id: 6, name: "أ. ريهام سمير", subject: "رياضيات", stage: "إعدادي", area: "المعادي", price: 140, bio: "مدرسة رياضيات للمرحلة الإعدادية، حل مسائل مبسط.", phone: "01033344455", status: "approved", created_at: new Date().toISOString() },
      { id: 7, name: "أ. كريم منصور", subject: "أحياء", stage: "ثانوي", area: "مدينة نصر", price: 170, bio: "مدرس أحياء حديث التسجيل - بانتظار مراجعة الفريق.", phone: "01099988877", status: "pending", created_at: new Date().toISOString() },
    ],
    parents: [],
    reviews: [
      { id: 1, tutor_id: 1, parent_name: "ولي أمر - يوسف", rating: 5, text: "شرح ممتاز وتفاعل كويس جدًا مع ابني.", created_at: new Date().toISOString() },
      { id: 2, tutor_id: 1, parent_name: "طالبة - مريم", rating: 5, text: "بسّط المنهج جدًا، بحس بفرق كبير.", created_at: new Date().toISOString() },
      { id: 3, tutor_id: 2, parent_name: "ولي أمر - كريم", rating: 4, text: "ملتزمة بالمواعيد ومتابعة كويسة.", created_at: new Date().toISOString() },
      { id: 4, tutor_id: 3, parent_name: "ولي أمر - نور", rating: 5, text: "أفضل مدرس فيزياء تعاملنا معاه.", created_at: new Date().toISOString() },
      { id: 5, tutor_id: 5, parent_name: "ولي أمر - سلمى", rating: 5, text: "شرح متسلسل وواضح جدًا.", created_at: new Date().toISOString() },
    ],
    bookings: [],
    favorites: [], // { parent_id, tutor_id }
  };
}

let state;
if (fs.existsSync(DATA_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (e) {
    state = seedData();
  }
} else {
  state = seedData();
}

function save() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
}
if (!fs.existsSync(DATA_PATH)) save();

module.exports = { state, save };
