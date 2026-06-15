import { GoogleGenAI } from '@google/genai';
import fs from 'fs';

async function run() {
  try {
    const keys = JSON.parse(fs.readFileSync('../local_data/keys.json', 'utf8'));
    if (!keys.gemini) {
      console.log('No Gemini key');
      return;
    }
    const ai = new GoogleGenAI({ apiKey: keys.gemini });
    const response = await ai.models.list();
    const modelNames = [];
    for await (const model of response) {
      modelNames.push(model.name);
    }
    console.log(modelNames.join(', '));
  } catch (e) {
    console.error(e);
  }
}
run();
