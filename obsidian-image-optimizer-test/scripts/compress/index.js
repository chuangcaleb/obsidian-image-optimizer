import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import sharp from 'sharp';

// let your script
const inputPath = process.argv[2];

if (!inputPath || !fs.existsSync(inputPath)) {
	throw new Error('Image file does not exist:', inputPath);
}

const extension = path.extname(inputPath);

// The only thing that matters, is that you create your compressed image like the following:
// (1) same directory as original image
// (2) same filename as original image
// (3) replace extension with `.temp`
// This is how the plugin identifies the new compressed image, and handles accordingly
const outputPath = inputPath.replace(extension, `.temp`);

try {
	// I suggest using npm's `sharp`, but use whatever compression method/package you like
	// it's also up to you to tweak the configurations
	// e.g. quality, lossless/lossful, etc.
	sharp(inputPath).webp({quality: 70}).toFile(outputPath);

	console.log('Image compressed:', outputPath);
} catch (error) {
	console.error('Compression error:', error);
}
