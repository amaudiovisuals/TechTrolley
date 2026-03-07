const fs = require('fs');
const docPath = '/Users/user/.gemini/antigravity/brain/9273ea86-3166-46d2-9b9f-cae6f5e3b733/Tech_Trolley_Project_Document.md';
const docContent = fs.readFileSync(docPath, 'utf8');

// The image tag is very large because of base64 formatting, so we use a regex to replace it
const newContent = docContent.replace(/!\[System Architecture & User Flow Diagram\]\(.+?\)/s, '<div class="diagram-container">\n<img src="diagram.svg" alt="System Architecture & User Flow Diagram" />\n</div>');

fs.writeFileSync('/Users/user/TechTrolley/Tech_Trolley_Project_Document.md', newContent, 'utf8');
console.log('Markdown successfully prepared for SVG rendering.');
