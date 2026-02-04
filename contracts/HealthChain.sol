// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract HealthChain {
    struct RecordInfo {
        string cid;
        address doctor;
        uint256 timestamp;
        bytes32 patientKey;
    }

    mapping(string => RecordInfo) private records;
    mapping(bytes32 => string[]) private patientRecords;

    event RecordAdded(
        string indexed recordId,
        string cid,
        bytes32 indexed patientKey,
        address indexed doctor,
        uint256 timestamp
    );

    function storeRecord(
        string calldata _recordId,
        string calldata _cid,
        bytes32 _patientKey
    ) external {
        require(bytes(_recordId).length > 0, "recordId empty");
        require(bytes(_cid).length > 0, "cid empty");

        records[_recordId] = RecordInfo({
            cid: _cid,
            doctor: msg.sender,
            timestamp: block.timestamp,
            patientKey: _patientKey
        });

        if (_patientKey != bytes32(0)) {
            patientRecords[_patientKey].push(_recordId);
        }

        emit RecordAdded(_recordId, _cid, _patientKey, msg.sender, block.timestamp);
    }

    function verifyRecord(
        string calldata _recordId
    ) external view returns (string memory, address, uint256, bytes32) {
        RecordInfo memory info = records[_recordId];
        return (info.cid, info.doctor, info.timestamp, info.patientKey);
    }

    function getPatientRecords(bytes32 _patientKey) external view returns (string[] memory) {
        return patientRecords[_patientKey];
    }
}
