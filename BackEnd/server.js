require("dotenv").config();
const express = require("express");
const app = express();
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const PinataSDK = require("@pinata/sdk");
// Các thư viện trên dùng để kết nối Blockchain, IPFS, mã hóa AES, v.v.
// --- 1. CẤU HÌNH & KẾT NỐI ---

// A. Lấy Config Contract(Địa chỉ & ABI)
const { CONTRACT_ADDRESS, CONTRACT_ABI } = require("./contract");

// B. Kết nối Database.
const connectDB = require("../Database/connect");
const Patient = require("../Database/models/Patient");
const Record = require("../Database/models/Record");
const Doctor = require("../Database/models/Doctor");
const ChainSyncState = require("../Database/models/ChainSyncState");
const bcrypt = require("bcryptjs");

// Kết nối ngay lập tức.
connectDB();

// --- 1.1. TIỆN ÍCH MÃ HÓA & IPFS , BLOCKCHAIN, ĐỒNG BỘ CHUỖI,KẾT NỐI PINATA ---
const AES_SECRET = process.env.AES_SECRET || "CHANGE_ME_AES_SECRET";
const IPFS_API_URL =
  process.env.IPFS_API_URL || "https://ipfs.infura.io:5001/api/v0";
const IPFS_PROJECT_ID = (process.env.IPFS_PROJECT_ID || "").trim();
const IPFS_PROJECT_SECRET = (process.env.IPFS_PROJECT_SECRET || "").trim();
const PINATA_JWT = (process.env.PINATA_JWT || "").trim();
const PINATA_API_KEY = (process.env.PINATA_API_KEY || "").trim();
const PINATA_API_SECRET = (process.env.PINATA_API_SECRET || "").trim();
const PINATA_GATEWAY = (
  process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs/"
).trim();
const RPC_URL = process.env.RPC_URL || "https://evm-t3.cronos.org/";
const CHAIN_SYNC_INTERVAL_MS = Number(
  process.env.CHAIN_SYNC_INTERVAL_MS || 5 * 60 * 1000,
);
const CHAIN_BACKFILL_INTERVAL_MS = Number(
  process.env.CHAIN_BACKFILL_INTERVAL_MS || 10 * 60 * 1000,
);

let cachedIpfsClient = null;

if (!PINATA_JWT && !(PINATA_API_KEY && PINATA_API_SECRET)) {
  console.warn(
    "⚠️ Thiếu PINATA_JWT hoặc PINATA_API_KEY/PINATA_API_SECRET. Không thể dùng Pinata để lưu IPFS.",
  );
}

function getAesKey() {
  return crypto.createHash("sha256").update(AES_SECRET).digest();
}
// MÃ HÓA KIỂU AES-256-GCM
function encryptField(plainText) {
  const text = (plainText || "").toString();
  const key = getAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptField(payload) {
  if (!payload || !payload.data || !payload.iv || !payload.tag) return "";
  const key = getAesKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function hashPatientKey(cccd) {
  const normalized = (cccd || "").toString().trim();
  if (!normalized) return "0x" + "0".repeat(64);
  return "0x" + crypto.createHash("sha256").update(normalized).digest("hex");
}

function normalizeRecordId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return value.toString();
  if (value._isIndexed && value.hash) {
    return "";
  }
  try {
    const text = value.toString();
    return text && text !== "[object Object]" ? text : "";
  } catch (error) {
    return "";
  }
}

function normalizePatientKey(value) {
  if (!value) return "";
  const raw = value.toString().trim();
  if (!raw) return "";
  if (raw.startsWith("0x") && raw.length === 66) return raw.toLowerCase();
  if (!raw.startsWith("0x") && raw.length === 64) {
    return `0x${raw.toLowerCase()}`;
  }
  return raw.toLowerCase();
}

async function resolveDoctorNameFromWallet(wallet) {
  if (!wallet) return "";
  const normalized = wallet.toLowerCase();
  const doctor = await Doctor.findOne({ walletAddress: normalized });
  return doctor?.fullName || "";
}

function getIpfsClient() {
  if (cachedIpfsClient) return cachedIpfsClient;
  if (PINATA_JWT) {
    cachedIpfsClient = new PinataSDK({ pinataJWTKey: PINATA_JWT });
    return cachedIpfsClient;
  }
  if (PINATA_API_KEY && PINATA_API_SECRET) {
    cachedIpfsClient = new PinataSDK(PINATA_API_KEY, PINATA_API_SECRET);
    return cachedIpfsClient;
  }
  throw new Error("Thiếu PINATA_JWT hoặc PINATA_API_KEY/PINATA_API_SECRET.");
}

async function ipfsAddJson(data) {
  const client = getIpfsClient();
  const result = await client.pinJSONToIPFS(data);
  return result.IpfsHash;
}

async function ipfsGetJson(cid) {
  const url = `${PINATA_GATEWAY}${cid}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Không lấy được dữ liệu IPFS từ Pinata. Status: ${response.status}`,
    );
  }
  return await response.json();
}

function buildRecordPayload({ record, patient }) {
  const nameEnc = encryptField(patient.fullName || "");
  const cccdEnc = encryptField(patient.cccd || "");
  const patientKey = hashPatientKey(patient.cccd);

  const normalizedMeds = Array.isArray(record.medications)
    ? record.medications.map((med) => ({
        name: med.name || "",
        dose: med.dose || "",
        usage: med.usage || "",
      }))
    : [];

  return {
    schema: "healthchain:v2",
    recordId: record.recordId,
    patient: {
      nameEnc,
      cccdEnc,
      patientKey,
    },
    medicalHistory: patient.medicalHistory || "",
    visit: {
      diagnosis: record.diagnosis || "",
      symptoms: record.symptoms || "",
      clinicalIndications: record.clinicalIndications || "",
      treatmentPlan: record.treatmentPlan || "",
      medications: normalizedMeds,
    },
    createdAt: new Date().toISOString(),
  };
}

async function applyChainRecord({
  recordId,
  cid,
  patientKey,
  doctor,
  timestamp,
  txHash,
}) {
  if (!recordId || !cid) return;

  const data = await ipfsGetJson(cid);
  const patientName = decryptField(data?.patient?.nameEnc);
  const patientCCCD = decryptField(data?.patient?.cccdEnc);
  const medicalHistory = data?.medicalHistory || "";
  const visit = data?.visit || {};
  const resolvedDoctorName = await resolveDoctorNameFromWallet(doctor);
  const existingRecord = await Record.findOne({ recordId });
  const doctorNameToSet =
    existingRecord?.doctorName || resolvedDoctorName || "Bác sĩ";

  if (!patientCCCD) {
    console.warn("⚠️ Không giải mã được CCCD từ IPFS:", recordId);
    return;
  }

  await Patient.findOneAndUpdate(
    { cccd: patientCCCD },
    {
      $set: {
        cccd: patientCCCD,
        fullName: patientName || "",
        medicalHistory: medicalHistory || "",
        patientIndexKey: patientKey || hashPatientKey(patientCCCD),
        isVerified: true,
      },
    },
    { upsert: true },
  );

  await Record.findOneAndUpdate(
    { recordId },
    {
      $set: {
        recordId,
        patientCCCD,
        doctorName: doctorNameToSet,
        diagnosis: visit.diagnosis || "",
        symptoms: visit.symptoms || "",
        clinicalIndications: visit.clinicalIndications || "",
        treatmentPlan: visit.treatmentPlan || "",
        medications: Array.isArray(visit.medications) ? visit.medications : [],
        blockchainHash: cid,
        blockchainCid: cid,
        blockchainTx: txHash || null,
        patientIndexKey: patientKey || hashPatientKey(patientCCCD),
        chainDoctorWallet: doctor || null,
        chainTimestamp: timestamp ? Number(timestamp) : null,
        chainSyncedAt: new Date(),
        isVerified: true,
      },
    },
    { upsert: true },
  );
}

async function syncFromChain(forceStartBlock = null) {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider,
    );

    const latestBlock = await provider.getBlockNumber();
    
    let fromBlock;
    if (forceStartBlock !== null) {
      fromBlock = Number(forceStartBlock);
    } else {
      const state = await ChainSyncState.findOne({ key: "records" });
      fromBlock = state?.lastBlock ? state.lastBlock + 1 : Math.max(0, latestBlock - 5000);
    }

    if (fromBlock > latestBlock) return;

    const filter = contract.filters.RecordAdded();
    const maxRange = 2000;

    for (let start = fromBlock; start <= latestBlock; start += maxRange) {
      const end = Math.min(start + maxRange - 1, latestBlock);

      const logs = await provider.getLogs({
        ...filter,
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        let parsed = null;
        try {
          parsed = contract.interface.parseLog(log);
        } catch (parseError) {
          continue;
        }

        if (!parsed || !parsed.args) continue;

        const recordId = normalizeRecordId(parsed.args[0]);
        const cid = parsed.args[1];
        const patientKey = parsed.args[2];
        const doctor = parsed.args[3];
        const timestamp = parsed.args[4];

        if (!recordId) {
          console.warn(
            "⚠️ Bỏ qua log RecordAdded vì recordId bị index (không lấy được giá trị gốc).",
          );
          continue;
        }

        await applyChainRecord({
          recordId,
          cid,
          patientKey,
          doctor,
          timestamp,
          txHash: log.transactionHash,
        });
      }
    }

    // Cập nhật trạng thái block mới nhất đã đồng bộ
    await ChainSyncState.findOneAndUpdate(
      { key: "records" },
      { lastBlock: latestBlock, updatedAt: new Date() },
      { upsert: true },
    );
  } catch (error) {
    console.error("❌ Lỗi đồng bộ Blockchain:", error?.message || error);
  }
}

async function backfillFromChainFromPatients() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(
    CONTRACT_ADDRESS,
    CONTRACT_ABI,
    provider,
  );
  const patients = await Patient.find();
  let totalRecordIds = 0;
  let syncedRecords = 0;
  let failedRecords = 0;
  let skippedPatients = 0;

  for (const patient of patients) {
    const patientKey = normalizePatientKey(
      patient.patientIndexKey || hashPatientKey(patient.cccd || ""),
    );
    if (!patientKey || patientKey === "0x" + "0".repeat(64)) {
      skippedPatients += 1;
      continue;
    }

    const recordIds = await contract.getPatientRecords(patientKey);
    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      continue;
    }

    console.log(
      `🔎 Backfill: patientKey=${patientKey} records=${recordIds.length}`,
    );

    totalRecordIds += recordIds.length;

    for (const recordId of recordIds) {
      if (!recordId) continue;
      try {
        const result = await contract.verifyRecord(recordId);
        const cid = result[0];
        const doctor = result[1];
        const timestamp = result[2];
        const chainPatientKey = result[3];

        if (!cid) continue;

        await applyChainRecord({
          recordId,
          cid,
          patientKey: chainPatientKey || patientKey,
          doctor,
          timestamp,
        });
        syncedRecords += 1;
      } catch (error) {
        failedRecords += 1;
        console.error(
          `❌ Backfill failed for recordId=${recordId}:`,
          error?.message || error,
        );
      }
    }
  }

  return { totalRecordIds, syncedRecords, failedRecords, skippedPatients };
}

function startChainSync() {
  if (!RPC_URL || !CONTRACT_ADDRESS) return;
  backfillFromChainFromPatients().catch((error) => {
    console.error("❌ Lỗi backfill Blockchain:", error?.message || error);
  });
  syncFromChain();
  setInterval(syncFromChain, CHAIN_SYNC_INTERVAL_MS);
  setInterval(() => {
    backfillFromChainFromPatients().catch((error) => {
      console.error("❌ Lỗi backfill Blockchain:", error?.message || error);
    });
  }, CHAIN_BACKFILL_INTERVAL_MS);
}

// --- 2. CẤU HÌNH VIEW & STATIC ---
app.set("view engine", "ejs");

// Trỏ về thư mục Views của Frontend
app.set("views", path.join(__dirname, "../FrontEnd/views"));

// Trỏ về thư mục Public (CSS, JS, Images)
app.use(express.static(path.join(__dirname, "../FrontEnd/public")));

// Middleware đọc dữ liệu JSON và Form
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 3. CÁC ROUTES CHÍNH ---

// A. Trang chủ (Dashboard)
// --- Route: Trang chủ (Dashboard) ---
// --- File: BackEnd/server.js ---

// Route: Trang chủ (Dashboard)
// --- Route: Trang chủ (Dashboard) - BẢN DEBUG ---
app.get("/", async (req, res) => {
  console.log("-----------------------------------------");
  console.log("🔍 ĐANG TRUY CẬP TRANG CHỦ...");

  // Kiểm tra xem biến CONTRACT_ADDRESS có dữ liệu không
  console.log("📜 Địa chỉ Contract trong Server là:", CONTRACT_ADDRESS);

  if (!CONTRACT_ADDRESS) {
    console.error(
      "❌ LỖI: Server chưa đọc được địa chỉ Contract! Kiểm tra lại file contract.js hoặc dòng require.",
    );
  } else {
    console.log("✅ OK: Server đã có địa chỉ Contract.");
  }

  try {
    const totalRecords = await Record.countDocuments();
    const latestRecord = await Record.findOne().sort({ visitDate: -1 });
    const recentActivities = await Record.find()
      .sort({ visitDate: -1 })
      .limit(5);

    res.render("index", {
      title: "HealthChain - Dashboard",
      stats: {
        total: totalRecords,
        lastActivity: latestRecord ? latestRecord.visitDate : null,
        appointments: 0,
      },
      recentActivities: recentActivities,

      // --- DÒNG QUAN TRỌNG NHẤT ---
      contractAddress: CONTRACT_ADDRESS,
      contractABI: JSON.stringify(CONTRACT_ABI),
      // -----------------------------
    });
    console.log("🚀 Đã gửi dữ liệu sang giao diện thành công!");
  } catch (error) {
    console.error("❌ Lỗi khi lấy dữ liệu DB:", error);
    res.render("index", {
      title: "HealthChain - Dashboard",
      stats: { total: 0, lastActivity: null, appointments: 0 },
      recentActivities: [],
      contractAddress: "N/A", // Gửi tạm cái này để không lỗi ejs
    });
  }
  console.log("-----------------------------------------");
});

// B. Trang Danh Sách Bệnh Nhân (QUAN TRỌNG)
app.get("/patients", async (req, res) => {
  try {
    // Lấy dữ liệu mới nhất lên đầu
    let recordsRaw = await Record.find().sort({ visitDate: -1 });
    if (!recordsRaw || recordsRaw.length === 0) {
      const summary = await backfillFromChainFromPatients();
      console.log("📦 Backfill summary:", summary);
      recordsRaw = await Record.find().sort({ visitDate: -1 });
    }

    // Chuẩn hóa dữ liệu để gửi xuống EJS
    const records = recordsRaw.map((rec) => {
      const chainValue = rec.blockchainCid || rec.blockchainHash || "";
      return {
        id: rec.recordId,
        date: rec.visitDate ? rec.visitDate.toLocaleDateString("vi-VN") : "N/A",
        visitDateISO: rec.visitDate ? rec.visitDate.toISOString() : "",
        doctor: rec.doctorName,
        doctorName: rec.doctorName,
        patientCCCD: rec.patientCCCD || "",
        diagnosis: rec.diagnosis || "",
        symptoms: rec.symptoms || "",
        clinicalIndications: rec.clinicalIndications || "",
        treatmentPlan: rec.treatmentPlan || "",
        medications: Array.isArray(rec.medications) ? rec.medications : [],
        isVerified: rec.isVerified,
        blockchainCid: rec.blockchainCid || "",
        dbHash: chainValue || "Chưa đồng bộ", // CID/Hash lưu trong DB
      };
    });

    res.render("patients", {
      title: "Hồ sơ sức khỏe",
      records: records,
      // Gửi kèm Config để EJS dùng kết nối MetaMask
      contractAddress: CONTRACT_ADDRESS,
      contractABI: JSON.stringify(CONTRACT_ABI),
    });
  } catch (err) {
    console.error(err);
    res.render("patients", { title: "Lỗi", records: [] });
  }
});

// C. Trang Giao diện Tạo Bệnh Án
app.get("/create-record", (req, res) => {
  res.render("create-record", {
    title: "Tạo Bệnh Án",
    contractAddress: CONTRACT_ADDRESS,
    contractABI: JSON.stringify(CONTRACT_ABI),
  });
});

// --- 4. CÁC API XỬ LÝ DỮ LIỆU ---

// API 1: Lưu bệnh án vào MongoDB (Bước 1 - Chưa có Hash)
app.post("/api/create-record", async (req, res) => {
  try {
    const {
      diagnosis,
      symptoms,
      patientCCCD,
      doctorName,
      walletAddress,
      vitalsUpdate,
      medicalHistoryAppend,
      clinicalIndications,
      treatmentPlan,
      medications,
    } = req.body;

    if (!patientCCCD) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu CCCD bệnh nhân" });
    }

    const patientExists = await Patient.findOne({ cccd: patientCCCD });
    if (!patientExists) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy bệnh nhân" });
    }

    // Cập nhật chỉ số sinh mệnh mới (nếu có)
    const updates = {};
    if (vitalsUpdate && typeof vitalsUpdate === "object") {
      const currentVitals = patientExists.vitalSigns || {};
      const nextVitals = { ...currentVitals };
      let hasVitalsUpdate = false;

      if (
        vitalsUpdate.heightCm !== undefined &&
        vitalsUpdate.heightCm !== null
      ) {
        const heightValue = Number(vitalsUpdate.heightCm);
        if (!Number.isNaN(heightValue)) {
          nextVitals.heightCm = heightValue;
          hasVitalsUpdate = true;
        }
      }

      if (
        vitalsUpdate.weightKg !== undefined &&
        vitalsUpdate.weightKg !== null
      ) {
        const weightValue = Number(vitalsUpdate.weightKg);
        if (!Number.isNaN(weightValue)) {
          nextVitals.weightKg = weightValue;
          hasVitalsUpdate = true;
        }
      }

      if ((vitalsUpdate.bloodPressure || "").trim() !== "") {
        nextVitals.bloodPressure = (vitalsUpdate.bloodPressure || "").trim();
        hasVitalsUpdate = true;
      }

      if (
        vitalsUpdate.heartRate !== undefined &&
        vitalsUpdate.heartRate !== null
      ) {
        const heartRateValue = Number(vitalsUpdate.heartRate);
        if (!Number.isNaN(heartRateValue)) {
          nextVitals.heartRate = heartRateValue;
          hasVitalsUpdate = true;
        }
      }

      if (hasVitalsUpdate) {
        updates.vitalSigns = nextVitals;
      }
    }

    if (medicalHistoryAppend && medicalHistoryAppend.trim()) {
      const existingHistory = patientExists.medicalHistory || "";
      const appendText = medicalHistoryAppend.trim();
      updates.medicalHistory = existingHistory
        ? `${existingHistory}\n- ${appendText}`
        : appendText;
    }

    if (Object.keys(updates).length > 0) {
      await Patient.updateOne({ cccd: patientCCCD }, { $set: updates });
    }

    // Tạo mã hồ sơ ngẫu nhiên (Ví dụ: REC-1234)
    const newId = "REC-" + Math.floor(Math.random() * 10000);

    let resolvedDoctorName = (doctorName || "").trim();
    if (!resolvedDoctorName && walletAddress) {
      const normalizedWallet = walletAddress.toLowerCase();
      const doctor = await Doctor.findOne({ walletAddress: normalizedWallet });
      if (doctor && doctor.fullName) {
        resolvedDoctorName = doctor.fullName;
      }
    }

    const newRecord = new Record({
      recordId: newId,
      patientCCCD: patientCCCD,
      doctorName: resolvedDoctorName || "Bác sĩ",
      diagnosis: diagnosis,
      symptoms: symptoms,
      clinicalIndications: clinicalIndications || "",
      treatmentPlan: treatmentPlan || "",
      medications: Array.isArray(medications) ? medications : [],
      isVerified: false, // Mới tạo chưa xác thực
      blockchainHash: "", // Chưa có Hash
      visitDate: new Date(),
    });

    await newRecord.save();
    console.log("✅ Đã lưu MongoDB (Chờ Hash):", newId);

    // Trả về ID để Frontend dùng tiếp cho bước ký Blockchain
    res.json({ success: true, message: "Lưu thành công!", id: newId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 1.5: Chuẩn bị dữ liệu on-chain (AES + IPFS) và trả CID
app.post("/api/prepare-chain-record", async (req, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu recordId" });
    }

    const record = await Record.findOne({ recordId });
    if (!record) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy hồ sơ" });
    }

    const patient = await Patient.findOne({ cccd: record.patientCCCD });
    if (!patient) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy bệnh nhân" });
    }

    const payload = buildRecordPayload({ record, patient });
    const cid = await ipfsAddJson(payload);

    await Record.findOneAndUpdate(
      { recordId },
      {
        blockchainCid: cid,
        blockchainHash: cid,
        patientIndexKey: payload.patient.patientKey,
      },
    );

    await Patient.findOneAndUpdate(
      { cccd: patient.cccd },
      { patientIndexKey: payload.patient.patientKey },
    );

    return res.json({
      success: true,
      recordId,
      cid,
      patientKey: payload.patient.patientKey,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 1.6: Kiểm tra và đồng bộ lại dữ liệu từ Blockchain
app.post("/api/verify-record", async (req, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu recordId" });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider,
    );

    const result = await contract.verifyRecord(recordId);
    const cid = result[0];
    const doctor = result[1];
    const timestamp = result[2];
    const patientKey = result[3];

    if (!cid) {
      return res.json({
        success: true,
        status: "missing",
        message: "Hồ sơ chưa có trên Blockchain",
        cid: "",
        doctor: "",
        timestamp: 0,
        patientKey: patientKey || "",
      });
    }

    await applyChainRecord({
      recordId,
      cid,
      patientKey,
      doctor,
      timestamp,
    });

    return res.json({
      success: true,
      status: "synced",
      message: "Đã đồng bộ dữ liệu từ Blockchain",
      cid,
      doctor,
      timestamp: Number(timestamp || 0),
      patientKey: patientKey || "",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 1.7: Tra cứu recordIds theo patientKey
app.get("/api/patient-records", async (req, res) => {
  try {
    const patientKey = (req.query.patientKey || "").trim();
    if (!patientKey) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu patientKey" });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider,
    );

    const recordIds = await contract.getPatientRecords(patientKey);
    return res.json({ success: true, patientKey, recordIds });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 1.7.1: Backfill dữ liệu từ Blockchain theo danh sách bệnh nhân trong DB
app.post("/api/backfill-chain", async (req, res) => {
  try {
    const summary = await backfillFromChainFromPatients();
    return res.json({ success: true, summary });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ success: false, message: error.message || "Lỗi Server" });
  }
});

// API 1.8: KHÔI PHỤC TOÀN BỘ DỮ LIỆU TỪ BLOCKCHAIN (Disaster Recovery)
// API này chứng minh rằng dù mất DB, chỉ cần Blockchain còn là dữ liệu còn.
app.post("/api/admin/resync-all", async (req, res) => {
  try {
    console.log("⚠️ Đang thực hiện khôi phục toàn bộ dữ liệu từ Blockchain...");
    
    // 1. Xóa trạng thái đồng bộ cũ để tránh conflict
    await ChainSyncState.deleteMany({ key: "records" });

    // 2. Gọi hàm đồng bộ bắt đầu từ Block 0 (hoặc block deploy contract)
    // Chạy ngầm (không await) để trả về response ngay cho client đỡ timeout
    syncFromChain(0).then(() => console.log("✅ Khôi phục dữ liệu hoàn tất!"));

    return res.json({ success: true, message: "Đang tiến hành khôi phục dữ liệu từ Block 0. Vui lòng đợi vài phút và tải lại trang." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 1.6: Tra cứu bệnh nhân + lịch sử khám bệnh
app.get("/api/search-patient", async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    if (!query) {
      return res.status(400).json({ success: false, message: "Thiếu từ khóa" });
    }

    const patient = await Patient.findOne({
      $or: [{ cccd: query }, { phone: query }],
    });

    if (!patient) {
      return res.json({ success: true, patient: null, records: [] });
    }

    const recordsRaw = await Record.find({ patientCCCD: patient.cccd }).sort({
      visitDate: -1,
    });

    const records = recordsRaw.map((rec) => ({
      recordId: rec.recordId,
      diagnosis: rec.diagnosis,
      doctorName: rec.doctorName,
      visitDate: rec.visitDate,
    }));

    return res.json({ success: true, patient, records });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 1.5: Lưu hồ sơ bệnh nhân vào MongoDB
app.post("/api/create-patient", async (req, res) => {
  try {
    const {
      fullName,
      cccd,
      birthDate,
      phone,
      address,
      vitalSigns,
      medicalHistory,
    } = req.body;

    if (!fullName || !cccd) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu họ tên hoặc CCCD" });
    }

    const exists = await Patient.findOne({ cccd });
    if (exists) {
      return res.status(409).json({
        success: false,
        message: "CCCD đã tồn tại trong hệ thống",
      });
    }

    const newPatient = new Patient({
      fullName,
      cccd,
      birthDate,
      phone,
      address,
      vitalSigns,
      medicalHistory,
      patientIndexKey: hashPatientKey(cccd),
    });

    await newPatient.save();
    return res.json({
      success: true,
      message: "Đã lưu hồ sơ bệnh nhân",
      patientKey: hashPatientKey(cccd),
    });
  } catch (error) {
    console.error(error);
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "CCCD đã tồn tại trong hệ thống",
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || "Lỗi Server",
    });
  }
});

// API 2: Cập nhật Hash sau khi ký Blockchain thành công (Bước 2)
app.post("/api/update-hash", async (req, res) => {
  try {
    const { recordId, hash, cid, txHash, patientKey } = req.body;

    console.log(`🔄 Đang đồng bộ Hash cho hồ sơ ${recordId}...`);

    // Tìm hồ sơ và cập nhật mã Hash
    await Record.findOneAndUpdate(
      { recordId: recordId },
      {
        blockchainHash: cid || hash, // Lưu CID/Hash từ Blockchain về
        blockchainCid: cid || hash || null,
        blockchainTx: txHash || null,
        patientIndexKey: patientKey || null,
        isVerified: true, // Đánh dấu là Tin cậy (Xanh)
      },
    );

    console.log(`✅ Đồng bộ HOÀN TẤT cho ${recordId}`);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// API 2.05: Đếm số hồ sơ theo bác sĩ
app.get("/api/count-records", async (req, res) => {
  try {
    let doctorName = (req.query.doctorName || "").trim();
    const walletAddress = (req.query.walletAddress || "").trim();

    if (!doctorName && walletAddress) {
      const doctor = await Doctor.findOne({
        walletAddress: walletAddress.toLowerCase(),
      });
      if (doctor && doctor.fullName) {
        doctorName = doctor.fullName;
      }
    }

    const total = doctorName
      ? await Record.countDocuments({ doctorName })
      : await Record.countDocuments();
    return res.json({ success: true, total });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 2.4: Cập nhật hash bệnh nhân sau khi ký Blockchain
app.post("/api/update-patient-hash", async (req, res) => {
  try {
    const { cccd, hash } = req.body;
    if (!cccd || !hash) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu CCCD hoặc hash" });
    }

    await Patient.findOneAndUpdate(
      { cccd },
      { blockchainHash: hash, isVerified: true },
    );

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 2.1: Thêm bác sĩ mới (yêu cầu ví)
app.post("/api/create-doctor", async (req, res) => {
  try {
    const {
      fullName,
      email,
      cccd,
      dob,
      phone,
      address,
      spec,
      license,
      walletAddress,
    } = req.body;

    if (!fullName || !email || !cccd || !spec || !walletAddress) {
      return res.status(400).json({
        success: false,
        message:
          "Thiếu thông tin bắt buộc (Họ tên, Email, CCCD, Chuyên khoa, Ví)",
      });
    }

    const normalizedWallet = walletAddress.toLowerCase();

    const exists = await Doctor.findOne({
      $or: [{ cccd }, { walletAddress: normalizedWallet }],
    });

    if (exists) {
      return res.status(409).json({
        success: false,
        message: "CCCD hoặc địa chỉ ví đã tồn tại",
      });
    }

    const newDoctor = new Doctor({
      fullName,
      email,
      cccd,
      dob,
      phone,
      address,
      spec,
      license,
      walletAddress: normalizedWallet,
    });

    await newDoctor.save();
    return res.json({ success: true, message: "Đã thêm bác sĩ" });
  } catch (error) {
    console.error(error);
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "CCCD hoặc địa chỉ ví đã tồn tại",
      });
    }
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 2.1.1: Cập nhật thông tin bác sĩ
app.post("/api/update-doctor", async (req, res) => {
  try {
    const {
      id,
      fullName,
      email,
      dob,
      phone,
      address,
      spec,
      license,
      walletAddress,
      status,
    } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: "Thiếu ID" });
    }

    const updates = {};
    if (fullName !== undefined) updates.fullName = fullName;
    if (email !== undefined) updates.email = email;
    if (dob !== undefined) updates.dob = dob;
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (spec !== undefined) updates.spec = spec;
    if (license !== undefined) updates.license = license;
    if (status !== undefined) updates.status = status;

    if (walletAddress !== undefined) {
      const normalizedWallet = (walletAddress || "").trim().toLowerCase();
      if (normalizedWallet) {
        const exists = await Doctor.findOne({
          _id: { $ne: id },
          walletAddress: normalizedWallet,
        });
        if (exists) {
          return res.status(409).json({
            success: false,
            message: "Địa chỉ ví đã tồn tại",
          });
        }
      }
      updates.walletAddress = normalizedWallet || "";
    }

    const updated = await Doctor.findByIdAndUpdate(id, updates, { new: true });
    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy bác sĩ" });
    }

    return res.json({ success: true, doctor: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 2.1.2: Cập nhật trạng thái bác sĩ
app.post("/api/doctor/status", async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu ID hoặc trạng thái" });
    }

    const updated = await Doctor.findByIdAndUpdate(
      id,
      { status },
      { new: true },
    );

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy bác sĩ" });
    }

    return res.json({ success: true, doctor: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 2.1.3: Xóa bác sĩ
app.delete("/api/doctor/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Thiếu ID" });
    }

    const deleted = await Doctor.findByIdAndDelete(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy bác sĩ" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// API 2.2: Đăng nhập bằng ví bác sĩ
app.post("/api/login-wallet", async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        message: "Thiếu địa chỉ ví",
      });
    }

    const normalizedWallet = walletAddress.toLowerCase();
    const doctor = await Doctor.findOne({ walletAddress: normalizedWallet });

    if (!doctor) {
      return res.status(401).json({
        success: false,
        message: "Địa chỉ ví không được phép đăng nhập",
      });
    }

    if (doctor.status && doctor.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Tài khoản đang bị tạm dừng",
      });
    }

    return res.json({ success: true, doctor: { fullName: doctor.fullName } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// API 2.3: Đăng nhập admin bằng email/password
app.post("/api/login-admin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Thiếu email hoặc mật khẩu",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const admin = await Doctor.findOne({
      role: "admin",
      email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i"),
    });
    if (!admin || !admin.passwordHash) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản không hợp lệ",
      });
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      return res.status(401).json({
        success: false,
        message: "Sai mật khẩu",
      });
    }

    return res.json({ success: true, admin: { fullName: admin.fullName } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Lỗi Server" });
  }
});

// --- 5. CÁC ROUTES PHỤ (Views tĩnh) ---
// --- Route: Xem chi tiết bệnh án ---
app.get("/record/:id", async (req, res) => {
  try {
    const recordId = req.params.id;
    const role = req.query.role || "admin";
    const cccd = req.query.cccd || "";
    // Tìm hồ sơ trong DB
    const record = await Record.findOne({ recordId: recordId });

    if (!record) {
      return res
        .status(404)
        .send(
          "<h1>❌ Không tìm thấy hồ sơ này!</h1><a href='/patients'>Quay lại</a>",
        );
    }

    if (role === "patient" && cccd !== record.patientCCCD) {
      return res
        .status(403)
        .send("<h1>❌ Bạn không có quyền xem hồ sơ này!</h1>");
    }

    const patient = await Patient.findOne({ cccd: record.patientCCCD });

    res.render("record-detail", {
      title: "Chi tiết hồ sơ - " + recordId,
      record: record, // Gửi dữ liệu bệnh án xuống
      patient: patient,
      role: role,
      cccd: cccd,
      contractAddress: CONTRACT_ADDRESS,
      contractABI: JSON.stringify(CONTRACT_ABI),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Lỗi Server");
  }
});
app.get("/login", (req, res) => res.render("login", { title: "Đăng nhập" }));
app.get("/logout", (req, res) => res.redirect("/login"));
app.get("/create-patient", (req, res) =>
  res.render("create-patient", {
    title: "Tạo Hồ Sơ",
    contractAddress: CONTRACT_ADDRESS,
    contractABI: JSON.stringify(CONTRACT_ABI),
  }),
);
app.get("/accounts", async (req, res) => {
  try {
    const doctors = await Doctor.find().sort({ createdAt: -1 });
    res.render("accounts", { title: "Tài khoản", doctors });
  } catch (error) {
    console.error(error);
    res.render("accounts", { title: "Tài khoản", doctors: [] });
  }
});
app.get("/activity-log", async (req, res) => {
  try {
    const patients = await Patient.find().sort({ createdAt: -1 });
    res.render("activity-log", {
      title: "Quản lý bệnh nhân",
      patients,
    });
  } catch (error) {
    console.error(error);
    res.render("activity-log", {
      title: "Quản lý bệnh nhân",
      patients: [],
    });
  }
});

// Route: Chi tiết bệnh nhân
app.get("/patient/:cccd", async (req, res) => {
  try {
    const cccd = req.params.cccd;
    const role = req.query.role || "admin";
    const patient = await Patient.findOne({ cccd });

    if (!patient) {
      return res
        .status(404)
        .send(
          "<h1>❌ Không tìm thấy bệnh nhân!</h1><a href='/activity-log'>Quay lại</a>",
        );
    }

    const records = await Record.find({ patientCCCD: cccd }).sort({
      visitDate: -1,
    });

    res.render("patient-detail", {
      title: "Chi tiết bệnh nhân",
      patient,
      records,
      role,
      contractAddress: CONTRACT_ADDRESS,
      contractABI: JSON.stringify(CONTRACT_ABI),
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Lỗi Server");
  }
});

// --- 6. KHỞI ĐỘNG SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại: http://localhost:${PORT}`);
  startChainSync();
});
