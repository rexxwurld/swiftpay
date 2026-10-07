// src/utils/fileType.js
//
// Identifies an uploaded file by its leading bytes ("magic numbers"), never
// by the client-supplied filename or Content-Type - both are trivially
// spoofed. Only JPEG, PNG and PDF are accepted for KYC documents.
function detectFileType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return null;
}

module.exports = { detectFileType };
