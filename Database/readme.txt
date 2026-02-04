# Database Module

Thư mục này chứa cấu hình kết nối CSDL MongoDB và các định nghĩa Schema (Models) cho hệ thống quản lý sức khỏe người cao tuổi trên Blockchain.

## Cấu trúc

- `connect.js`: Script cấu hình và khởi tạo kết nối đến MongoDB Atlas.
- `models/`: Thư mục chứa các Mongoose Schema.
  - `ChainSyncState.js`: Lưu trạng thái đồng bộ với Blockchain (block cuối cùng đã xử lý).
  - `Doctor.js`: Thông tin bác sĩ, bao gồm ví blockchain, giấy phép hành nghề.
  - `Patient.js`: Hồ sơ bệnh nhân cơ bản, chỉ số sinh tồn và hash đối chiếu.
  - `Record.js`: Hồ sơ khám bệnh chi tiết, bao gồm chẩn đoán, đơn thuốc và các trường liên kết Blockchain (CID, TxHash).

## Thông tin kết nối (Connection String)

Chuỗi kết nối hiện tại (sử dụng trong connect.js):
`mongodb+srv://BlockChain:BlockChain@blockchain.o4qa0fb.mongodb.net/HealthChainDB?retryWrites=true&w=majority&appName=BlockChain`

Lưu ý: Đảm bảo IP của bạn đã được Whitelist trên MongoDB Atlas để có thể kết nối.