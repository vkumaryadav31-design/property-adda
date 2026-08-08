const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfImgConvert = require('pdf-img-convert');
const sharp = require('sharp');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); 

// --- Configuration & Keys ---
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY || 'YOUR_AWS_ACCESS_KEY',
        secretAccessKey: process.env.AWS_SECRET_KEY || 'YOUR_AWS_SECRET_KEY',
    },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_RAZORPAY_KEY_SECRET'
});

// --- Database Schema ---
// mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/layout_db');
const layoutSchema = new mongoose.Schema({
    layoutName: { type: String, required: true },
    location: { type: String, required: true },
    surveyNumber: { type: String, required: true },
    fileHash: { type: String, required: true, unique: true },
    s3FileKey: { type: String, required: true },
    enhancedS3FileKey: { type: String }
});
layoutSchema.index({ layoutName: 1, location: 1, surveyNumber: 1 }, { unique: true });
const Layout = mongoose.model('Layout', layoutSchema);

// --- Helpers ---
const streamToBuffer = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
};

async function enhancePdfClarity(pdfBuffer) {
    const pageImages = await pdfImgConvert.convert(pdfBuffer, { page_numbers: [1], scale: 2.0 });
    return await sharp(Buffer.from(pageImages[0]))
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1.5 })
        .png({ quality: 100 })
        .toBuffer();
}

// --- API Endpoints ---
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });

// 1. Upload Flow
app.post('/check-duplicate', async (req, res) => {
    try {
        const existingLayout = await Layout.findOne({ fileHash: req.body.hash });
        res.json({ exists: !!existingLayout });
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/generate-presigned-url', uploadLimiter, async (req, res) => {
    try {
        const { fileName, fileType } = req.body;
        const fileKey = `layouts/${Date.now()}-${fileName.replace(/\s+/g, '-')}`;
        const command = new PutObjectCommand({ Bucket: 'YOUR_BUCKET_NAME', Key: fileKey, ContentType: fileType });
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });
        res.json({ uploadUrl: signedUrl, fileKey: fileKey });
    } catch (error) {
        res.status(500).json({ error: 'Could not generate signed URL' });
    }
});

app.post('/extract-metadata', async (req, res) => {
    try {
        const { s3FileKey } = req.body;
        if (!s3FileKey) return res.status(400).json({ error: 'No file key provided.' });

        const getCommand = new GetObjectCommand({ Bucket: 'YOUR_BUCKET_NAME', Key: s3FileKey });
        const originalPdfBuffer = await streamToBuffer((await s3Client.send(getCommand)).Body);
        
        const enhancedImageBuffer = await enhancePdfClarity(originalPdfBuffer);
        const enhancedFileKey = s3FileKey.replace('.pdf', '-enhanced.png');
        
        await s3Client.send(new PutObjectCommand({
            Bucket: 'YOUR_BUCKET_NAME', Key: enhancedFileKey, Body: enhancedImageBuffer, ContentType: 'image/png'
        }));

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent([
            `Analyze this property layout. Extract surveyNumber, location, and layoutName strictly as JSON.`,
            { inlineData: { data: enhancedImageBuffer.toString("base64"), mimeType: "image/png" } }
        ]);

        res.json({ success: true, data: JSON.parse(result.response.text()), enhancedFileKey });
    } catch (error) {
        res.status(500).json({ error: 'Failed to enhance or extract metadata.' });
    }
});

app.post('/save-layout', async (req, res) => {
    try {
        const newLayout = new Layout(req.body);
        const savedLayout = await newLayout.save();
        res.json({ success: true, layoutId: savedLayout._id });
    } catch (error) {
        res.status(400).json({ error: 'Could not save layout. Possible duplicate.' });
    }
});

// 2. View Mode & AI
app.get('/api/layout/:id', async (req, res) => {
    try {
        const layout = await Layout.findById(req.params.id);
        if (!layout) return res.status(404).json({ error: 'Layout not found' });
        
        const command = new GetObjectCommand({ Bucket: 'YOUR_BUCKET_NAME', Key: layout.enhancedS3FileKey || layout.s3FileKey });
        const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        
        res.json({ layoutName: layout.layoutName, location: layout.location, surveyNumber: layout.surveyNumber, imageUrl: viewUrl });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve layout data.' });
    }
});

app.post('/ask-ai', async (req, res) => {
    try {
        const { question, s3FileKey } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        let promptParts = [
            "You are a real estate assistant for LayoutManager. Answer the user's question.",
            `User Question: ${question}`
        ];

        if (s3FileKey) {
            const command = new GetObjectCommand({ Bucket: 'YOUR_BUCKET_NAME', Key: s3FileKey });
            const fileBuffer = await streamToBuffer((await s3Client.send(command)).Body);
            promptParts.push({ inlineData: { data: fileBuffer.toString("base64"), mimeType: s3FileKey.endsWith('.png') ? "image/png" : "application/pdf" } });
            promptParts[0] = "Analyze the attached layout and answer the question.";
        }

        const result = await model.generateContent(promptParts);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: 'AI failed to process.' });
    }
});

// 3. Razorpay Payments
app.post('/create-download-order', async (req, res) => {
    try {
        const options = { amount: 100 * 100, currency: "INR", receipt: `rcpt_${Date.now()}` };
        const order = await razorpay.orders.create(options);
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Payment initialization failed' });
    }
});

app.post('/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, layoutId } = req.body;
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'YOUR_RAZORPAY_KEY_SECRET').update(body.toString()).digest('hex');

    if (expectedSignature === razorpay_signature) {
        const layout = await Layout.findById(layoutId);
        const command = new GetObjectCommand({ 
            Bucket: 'YOUR_BUCKET_NAME', 
            Key: layout.enhancedS3FileKey || layout.s3FileKey,
            ResponseContentDisposition: 'attachment; filename="LayoutManager-Download.png"'
        });
        const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
        res.json({ success: true, downloadUrl: downloadUrl });
    } else {
        res.status(400).json({ success: false, error: 'Payment verification failed' });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
