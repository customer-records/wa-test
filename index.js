const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const qrcode = require("qrcode-terminal");
const jsQR = require("jsqr");
const { createCanvas, loadImage } = require("canvas");

const TARGET_HOUR = 10;
const TARGET_MINUTE = 0;
const USER_DATA_DIR = path.join(__dirname, "puppeteer-data");

function getImagesForToday() {
  const today = DateTime.now().setZone("Europe/Moscow").weekday; // Без -1

  if (today === 7) {
    console.log("Сегодня воскресенье — публикация отменена.");
    return [];
  }

  const imageMap = {
    1: ["story1.JPEG", "story2.JPEG"], // Понедельник
    2: ["story3.JPEG", "story4.JPEG"], // Вторник
    3: ["story5.JPEG", "story1.JPEG"], // Среда
    4: ["story2.JPEG", "story3.JPEG"], // Четверг
    5: ["story4.JPEG", "story5.JPEG"], // Пятница
    6: ["story1.JPEG", "story2.JPEG"], // Суббота
  };

  return imageMap[today] || [];
}

function waitUntilTargetTime(offsetMinutes = 0) {
  const moscowNow = DateTime.now().setZone("Europe/Moscow");
  let target = moscowNow.set({
    hour: TARGET_HOUR,
    minute: TARGET_MINUTE + offsetMinutes,
    second: 0,
    millisecond: 0,
  });
  if (moscowNow > target) target = target.plus({ days: 1 });
  const waitTime = target.diff(moscowNow).as("milliseconds");
  console.log(`Ждём до: ${target.toFormat("dd.MM.yyyy HH:mm:ss")} (МСК)`);
  return new Promise((resolve) => setTimeout(resolve, waitTime));
}

async function waitForQr(page, timeout = 30000) {
  try {
    await page.waitForSelector(
      'canvas[aria-label="Scan this QR code to link a device!"]',
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function extractQrCode(page) {
  let qrAlreadyShown = false;
  while (true) {
    const qrCanvas = await page.$(
      'canvas[aria-label="Scan this QR code to link a device!"]'
    );
    if (!qrCanvas) {
      console.log("✅ QR-код исчез, авторизация выполнена.");
      return;
    }
    try {
      const qrData = await qrCanvas.screenshot({ encoding: "base64" });
      const img = await loadImage(Buffer.from(qrData, "base64"));
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const code = jsQR(imageData.data, img.width, img.height);
      if (code && !qrAlreadyShown) {
        console.clear();
        console.log("Сканируйте QR-код:");
        qrcode.generate(code.data, { small: true });
        qrAlreadyShown = true;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function publishStatus(page, imageFile) {
  const imagePath = path.join(__dirname, imageFile);
  if (!fs.existsSync(imagePath)) {
    console.log("Файл не найден:", imagePath);
    return;
  }

  let el;

  el = await page.$("button[data-tab='2'][aria-label='Статус']");
  if (el) {
    await el.click();
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log("❌ Не найден элемент 'Статус'");
    return;
  }

  el = await page.$("button[aria-label='Add Status']");
  if (el) {
    await el.click();
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    console.log("❌ Не найдена кнопка 'Add Status'");
    return;
  }

  el = await page.$("span[data-icon='media-multiple']");
  if (el) {
    await el.click();
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    console.log("❌ Не найдена кнопка 'Фото и видео'");
    return;
  }

  el = await page.$("input[type='file']");
  if (el) {
    await el.uploadFile(imagePath);
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log("❌ Не найден input[type='file']");
    return;
  }

  el = await page.$("span[data-icon='send']");
  if (el) {
    await el.click();
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log("❌ Не найдена кнопка 'Отправить'");
    return;
  }

  console.log(`✅ История с файлом ${imageFile} успешно опубликована.`);
}

async function loop(page) {
  while (true) {
    const images = getImagesForToday();
    if (images.length === 0) {
      await new Promise((r) => setTimeout(r, 24 * 60 * 60 * 1000));
      continue;
    }

    await waitUntilTargetTime(0);
    await publishStatus(page, images[0]);

    await new Promise((r) => setTimeout(r, 24 * 60 * 60 * 1000));
  }
}

async function startPuppeteer() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    protocolTimeout: 300000, // Увеличенный протокольный таймаут
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.goto("https://web.whatsapp.com/");
  await new Promise((r) => setTimeout(r, 5000));

  const qrPresent = await waitForQr(page);
  if (qrPresent) {
    console.log("Обнаружен QR-код. Ждём авторизацию...");
    await extractQrCode(page);
    await page.waitForSelector('div[data-testid="chat-list"]', { timeout: 0 });
  } else {
    console.log("✅ Авторизация уже существует, QR-код не обнаружен.");
  }

  await loop(page);
}

startPuppeteer();
