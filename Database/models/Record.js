// models/Record.js
const mongoose = require("mongoose");

const RecordSchema = new mongoose.Schema({
  recordId: { type: String, required: true, unique: true }, // ID hiển thị (VD: REC-001)
  patientCCCD: { type: String, required: true },
  doctorName: String,
  diagnosis: String,
  symptoms: String,
  clinicalIndications: String,
  treatmentPlan: String,
  medications: [
    {
      name: String,
      dose: String,
      usage: String,
    },
  ], // Danh sách thuốc

  // Phần Blockchain
  blockchainHash: { type: String, default: null }, // CID hoặc Hash dữ liệu (tương thích cũ)
  blockchainCid: { type: String, default: null }, // CID dữ liệu trên IPFS
  blockchainTx: { type: String, default: null }, // Hash giao dịch trên mạng
  patientIndexKey: { type: String, default: null }, // bytes32 (hash CCCD) dùng để truy vết
  chainDoctorWallet: { type: String, default: null }, // Ví bác sĩ ký trên chain
  chainTimestamp: { type: Number, default: null }, // Timestamp on-chain
  chainSyncedAt: { type: Date, default: null },
  isVerified: { type: Boolean, default: false },

  visitDate: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Record", RecordSchema);
