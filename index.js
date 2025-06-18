const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const qrcode = require("qrcode-terminal");
const jsQR = require("jsqr");
const { createCanvas, loadImage } = require("canvas");

const TARGET_HOUR = 2;
const TARGET_MINUTE = 59;
const USER_DATA_DIR = path.join(__dirname, "puppeteer-data");

function getImagesForToday() {
  const today = DateTime.now().setZone("Europe/Moscow").weekday;
  if (today === 7) {
    console.log("Сегодня воскресенье — публикация отменена.");
    return [];
  }

  const imageMap = {
    1: ["story1.JPEG", "story2.JPEG"],
    2: ["story3.JPEG", "story4.JPEG"],
    3: ["story5.JPEG", "story1.JPEG"],
    4: ["story2.JPEG", "story3.JPEG"],
    5: ["story4.JPEG", "story5.JPEG"],
    6: ["story1.JPEG", "story2.JPEG"],
  };

  return imageMap[today] || [];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function waitForQr(page, timeout = 30000) {
  return page
    .waitForSelector(
      'canvas[aria-label="Scan this QR code to link a device!"]',
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

function extractQrCode(page) {
  let qrAlreadyShown = false;
  return new Promise(async (resolve) => {
    while (true) {
      const qrCanvas = await page.$(
        'canvas[aria-label="Scan this QR code to link a device!"]'
      );
      if (!qrCanvas) {
        console.log("✅ QR-код исчез, авторизация выполнена.");
        return resolve();
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
      } catch {}
      await wait(1000);
    }
  });
}

function publishStatus(page, imageFile) {
  const imagePath = path.join(__dirname, imageFile);
  if (!fs.existsSync(imagePath)) {
    console.log("Файл не найден:", imagePath);
    return Promise.resolve();
  }

  return page
    .$("button[aria-label='Статус']")
    .then((el) =>
      el
        ? el.click().then(() => wait(2000))
        : Promise.reject("❌ Не найден элемент 'Статус'")
    )
    .then(() => page.$("button[aria-label='Add Status']"))
    .then((el) =>
      el
        ? el.click().then(() => wait(1000))
        : Promise.reject("❌ Не найдена кнопка 'Add Status'")
    )
    .then(() =>
      page.$$eval("li", (elements) => {
        const target = elements.find((el) => el.textContent.includes("Фото"));
        if (!target) throw new Error("❌ Не найдена кнопка 'Фото и видео'");
        target.click();
      })
    )
    .then(() => wait(1000))
    .then(() => page.$("input[type='file']"))
    .then((el) =>
      el
        ? el.uploadFile(imagePath).then(() => wait(2000))
        : Promise.reject("❌ Не найден input[type='file']")
    )
    .then(() => page.$("div[aria-label='Отправить']"))
    .then((el) =>
      el
        ? el.click().then(() => wait(2000))
        : Promise.reject("❌ Не найдена кнопка 'Отправить'")
    )
    .then(() =>
      console.log(`✅ История с файлом ${imageFile} успешно опубликована.`)
    )
    .catch((err) => console.log(err));
}

function loop(page) {
  return new Promise(async () => {
    while (true) {
      const images = getImagesForToday();
      if (images.length === 0) {
        await wait(24 * 60 * 60 * 1000);
        continue;
      }

      await waitUntilTargetTime(0);
      await publishStatus(page, images[0]);
      await wait(24 * 60 * 60 * 1000);
    }
  });
}

function startPuppeteer() {
  puppeteer
    .launch({
      headless: false,
      userDataDir: USER_DATA_DIR,
      defaultViewport: null,
      protocolTimeout: 300000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })
    .then((browser) => browser.newPage())
    .then((page) => {
      return page
        .goto("https://web.whatsapp.com/")
        .then(() => wait(5000))
        .then(() => waitForQr(page))
        .then((qrPresent) => {
          if (qrPresent) {
            console.log("Обнаружен QR-код. Ждём авторизацию...");
            return extractQrCode(page)
              .then(() =>
                page.waitForSelector('div[data-testid="chat-list"]', {
                  timeout: 0,
                })
              )
              .then(() => page);
          } else {
            console.log("✅ Авторизация уже существует, QR-код не обнаружен.");
            return page;
          }
        });
    })
    .then((page) => loop(page))
    .catch((err) => console.error("Ошибка запуска:", err));
}

startPuppeteer();
