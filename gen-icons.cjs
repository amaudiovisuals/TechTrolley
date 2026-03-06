// Generates pwa-192x192.png and pwa-512x512.png from our SVG icon using sharp
// Run: node gen-icons.cjs
const fs = require('fs');
const path = require('path');

async function generate() {
    let sharp;
    try {
        sharp = require('sharp');
    } catch {
        console.log('sharp not found, installing...');
        const { execSync } = require('child_process');
        execSync('npm install sharp --legacy-peer-deps', { stdio: 'inherit' });
        sharp = require('sharp');
    }

    const svgPath = path.join(__dirname, 'public', 'pwa-icon.svg');
    const svgBuffer = fs.readFileSync(svgPath);

    const sizes = [
        { size: 192, name: 'pwa-192x192.png' },
        { size: 512, name: 'pwa-512x512.png' },
        { size: 180, name: 'apple-touch-icon.png' },
        { size: 32, name: 'favicon-32x32.png' },
        { size: 16, name: 'favicon-16x16.png' },
    ];

    for (const { size, name } of sizes) {
        const outPath = path.join(__dirname, 'public', name);
        await sharp(svgBuffer)
            .resize(size, size)
            .png()
            .toFile(outPath);
        console.log(`✅ Generated ${name} (${size}x${size})`);
    }

    console.log('\n🎉 All icons generated in /public/');
}

generate().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
