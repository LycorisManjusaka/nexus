const fs = require('fs');
const path = require('path');

const watchPath = 'C:\\Users\\user\\Pictures\\VRChat';

console.log(`Starting watcher on ${watchPath}`);
fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
  console.log(`Event: ${eventType}, Filename: ${filename}`);
});
