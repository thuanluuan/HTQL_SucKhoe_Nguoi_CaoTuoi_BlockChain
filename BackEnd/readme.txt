BackEnd - Hệ thống quản lý sức khỏe người cao tuổi (Blockchain)

1. Giới thiệu
- Đây là service BackEnd của hệ thống quản lý hồ sơ sức khỏe người cao tuổi.
- Lưu trữ dữ liệu bệnh nhân và hồ sơ khám chữa bệnh trên MongoDB.
- Đồng bộ và xác thực hồ sơ trên Blockchain (Cronos EVM) thông qua smart contract `HealthChain.sol` và file cấu hình `contract.js`.
- Dữ liệu nhạy cảm (tên, CCCD, lịch sử bệnh) được mã hóa và nội dung chi tiết hồ sơ được lưu trên IPFS (Pinata).

2. Kiến trúc tổng quan
- `server.js`: API server chính dùng Node.js/Express, kết nối MongoDB, Blockchain và IPFS.
- `contract.js`: Chứa địa chỉ (`CONTRACT_ADDRESS`) và ABI (`CONTRACT_ABI`) của smart contract đã deploy.
- `../contracts/HealthChain.sol`: Mã nguồn smart contract lưu thông tin hồ sơ sức khỏe trên chuỗi.
- `../Database/*`: Mô hình dữ liệu MongoDB cho `Patient`, `Record`, `Doctor`, `ChainSyncState` và hàm `connectDB`.

Luồng chính:
- Backend nhận dữ liệu hồ sơ khám bệnh từ client.
- Mã hóa trường nhạy cảm, chuẩn hóa `patientKey` từ CCCD, build payload bệnh án.
- Lưu payload lên IPFS (Pinata) → nhận về `cid`.
- Gọi smart contract `storeRecord(recordId, cid, patientKey)` để ghi hash lên chuỗi.
- Service định kỳ đọc event `RecordAdded` và hàm `getPatientRecords/verifyRecord` để đồng bộ dữ liệu từ Blockchain về MongoDB.

3. Yêu cầu môi trường
- Node.js 18+ (khuyến nghị).
- MongoDB đang chạy (local hoặc cloud).
- Đã deploy smart contract HealthChain trên mạng Cronos EVM (hoặc EVM tương thích) và có sẵn `CONTRACT_ADDRESS`, `CONTRACT_ABI`.
- Tài khoản Pinata (hoặc tương đương) để lưu trữ IPFS.

4. Biến môi trường (.env)
Tạo file `.env` trong thư mục `BackEnd` với các giá trị tương ứng:

- `MONGODB_URI`       : Chuỗi kết nối MongoDB.
- `RPC_URL`           : RPC URL của mạng Blockchain (ví dụ: https://evm-t3.cronos.org/).
- `AES_SECRET`        : Secret key dùng để mã hóa dữ liệu bệnh nhân (bắt buộc đổi, không dùng mặc định).
- `PINATA_JWT`        : JWT token của Pinata (khuyên dùng). Hoặc dùng cặp API key/secret bên dưới.
- `PINATA_API_KEY`    : API key của Pinata.
- `PINATA_API_SECRET` : API secret của Pinata.
- `PINATA_GATEWAY`    : URL gateway IPFS của Pinata (mặc định: https://gateway.pinata.cloud/ipfs/).
- `CHAIN_SYNC_INTERVAL_MS`      : Chu kỳ (ms) đồng bộ event mới từ Blockchain (mặc định ~5 phút).
- `CHAIN_BACKFILL_INTERVAL_MS`  : Chu kỳ (ms) backfill lại dữ liệu hồ sơ từ Blockchain (mặc định ~10 phút).
- `PORT`              : Cổng chạy server Express (ví dụ: 3000).

5. Cài đặt & chạy Backend
Trong thư mục `BackEnd`:

1) Cài đặt dependencies
	 - Cập nhật `package.json` để bao gồm các thư viện thực sự đang sử dụng (tham khảo danh sách dưới đây), sau đó chạy:
	 - `npm install`

	 Các thư viện thường dùng trong dự án:
	 - `express`
	 - `dotenv`
	 - `mongodb`
	 - `mongoose` (nếu dùng ODM cho MongoDB)
	 - `ethers`
	 - `@pinata/sdk`
	 - `bcryptjs`

2) Chạy server
	 - `node server.js`

3) Trong quá trình phát triển có thể dùng `nodemon`:
	 - Cài đặt: `npm install -D nodemon`
	 - Thêm script `dev` trong `package.json` và chạy: `npm run dev`

6. Chức năng chính của API (tóm tắt)
- Quản lý bệnh nhân (`Patient`):
	- Thêm/cập nhật thông tin bệnh nhân, chuẩn hóa `patientKey` từ CCCD, mã hóa thông tin nhạy cảm.
- Quản lý hồ sơ khám (`Record`):
	- Lưu chẩn đoán, triệu chứng, chỉ định lâm sàng, phác đồ điều trị, thuốc…
	- Lưu nội dung hồ sơ chi tiết lên IPFS, lưu hash (CID) + metadata lên Blockchain.
- Đồng bộ chuỗi (`ChainSyncState`):
	- Định kỳ quét event `RecordAdded` và backfill dữ liệu từ smart contract về MongoDB.
	- Ghi nhận block cuối cùng đã đồng bộ để tránh trùng lặp.
- Xác thực hồ sơ từ Blockchain:
	- Sử dụng `verifyRecord(recordId)` để truy vấn CID, bác sĩ, timestamp, patientKey.
	- Đối chiếu dữ liệu on-chain và off-chain (MongoDB) để đảm bảo tính toàn vẹn.

7. Ghi chú bảo mật
- Bắt buộc thay đổi `AES_SECRET` trong `.env` và không commit file `.env` lên Git.
- Hạn chế log dữ liệu nhạy cảm (CCCD, tên bệnh nhân, lịch sử bệnh).
- Cấu hình quyền truy cập API (auth/role-based) ở tầng route/middleware (trong `server.js` hoặc các file router tách riêng).

8. Hướng phát triển tiếp
- Bổ sung bộ test tự động (unit test/integration test) cho các chức năng chính.
- Chuẩn hóa cấu trúc dự án (chia nhỏ controller, service, route, model).
- Viết tài liệu chi tiết endpoint (OpenAPI/Swagger) cho FrontEnd và mobile.
- Thêm cơ chế giám sát, log, alert khi đồng bộ Blockchain/IPFS gặp lỗi.

9. Tác giả & liên hệ
- Dự án thuộc đề tài: Hệ thống quản lý sức khỏe người cao tuổi trên nền tảng Blockchain.
- Vui lòng xem thêm mô tả chung tại file `README.md` ở thư mục gốc dự án.
