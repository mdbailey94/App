import { existsSync } from 'node:fs';
import { fingerVideo } from './finger-video.mjs';
import { FINGER_VIDEO } from '../../playwright.config.mjs';

export default function globalSetup() {
  if (!existsSync(FINGER_VIDEO)) fingerVideo(FINGER_VIDEO);
}
