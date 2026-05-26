const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CLOUDINARY_INPUT_FOLDER = "pd-sku/inputs";
const CLOUDINARY_OUTPUT_FOLDER = "pd-sku/variants";

async function uploadBuffer(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: "auto" },
      (err, result) => {
        if (err) reject(new Error(`Cloudinary upload failed: ${err.message}`));
        else resolve(result);
      },
    );
    stream.end(buffer);
  });
}

async function uploadInputImage(buffer) {
  const result = await uploadBuffer(
    buffer,
    CLOUDINARY_INPUT_FOLDER,
    `input_${Date.now()}`,
  );
  return result.secure_url;
}

async function uploadVariant(buffer, batchIdShort, index) {
  const result = await uploadBuffer(
    buffer,
    `${CLOUDINARY_OUTPUT_FOLDER}/${batchIdShort}`,
    `variant_${index}`,
  );
  return {
    variantId: `variant_${index}`,
    imageUrl: result.secure_url,
    fileName: result.public_id,
  };
}

module.exports = { uploadInputImage, uploadVariant };
