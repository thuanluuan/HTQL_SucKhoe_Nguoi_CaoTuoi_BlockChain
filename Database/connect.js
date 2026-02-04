// database/connect.js
const mongoose = require("mongoose");

// Chuỗi kết nối MongoDB Atlas
const dbURI =
  "mongodb+srv://BlockChain:BlockChain@blockchain.o4qa0fb.mongodb.net/HealthChainDB?retryWrites=true&w=majority&appName=BlockChain";

const connectDB = async () => {
  try {
    // Kết nối với các tùy chọn mặc định cho Mongoose 6+
    await mongoose.connect(dbURI);
    console.log("✅ Đã kết nối thành công với MongoDB Atlas (HealthChainDB)!");
  } catch (err) {
    console.error("❌ Lỗi kết nối MongoDB:", err.message);
    // Dừng server nếu không kết nối được DB
    process.exit(1);
  }
};

module.exports = connectDB;
