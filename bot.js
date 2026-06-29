console.log("הקובץ התחיל לרוץ");

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const QRcode = require('qrcode');

let schedulerStarted = false;

const client = new Client({
    authStrategy: new LocalAuth(),
    restartOnAuthFail: true,
    puppeteer: {
        executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
        headless: true,
        protocolTimeout: 120000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

// טעינת הטקסט
const text = fs.readFileSync('mesilat.txt', 'utf-8');

// פיצול לפרקים
function splitChapters(text) {

    const regex = /(הקדמה|פרק\s+[א-ת]+)([\s\S]*?)(?=הקדמה|פרק\s+[א-ת]+|$)/g;

    let match;
    let chapters = [];

    while ((match = regex.exec(text)) !== null) {

        chapters.push({
            title: match[1],
            content: match[2].trim()
        });
    }

    return chapters;
}

// חלוקה חכמה בתוך פרק
function splitChapterToParts(chapterText, targetSize) {

    const paragraphs = chapterText
        .split('\n')
        .filter(p => p.trim() !== '');

    let parts = [];
    let current = '';

    for (let p of paragraphs) {

        if ((current + p).length < targetSize) {

            current += p + '\n\n';

        } else {

            if (current.length > targetSize * 0.5) {

                parts.push(current);
                current = p + '\n\n';

            } else {

                current += p + '\n\n';
            }
        }
    }

    if (current) {
        parts.push(current);
    }

    return parts;
}

// יצירת כל החלקים
function buildAllParts(text, days = 200) {

    const chapters = splitChapters(text);

    console.log("כמות פרקים שנמצאו:", chapters.length);

    const totalLength = text.length;
    const targetSize = Math.floor(totalLength / days);

    let allParts = [];

    for (let chapter of chapters) {

        const parts = splitChapterToParts(
            chapter.content,
            targetSize
        );

        parts.forEach((p) => {

            allParts.push({
                title: chapter.title,
                text: p
            });
        });
    }

    return allParts;
}

const parts = buildAllParts(text, 200);

console.log("כמות חלקים:", parts.length);

if (parts.length > 0) {
    console.log("חלק ראשון:");
    console.log(parts[0]);
} else {
    console.log("לא נמצאו חלקים!");
}

const progressFile = 'progress.json';

function getCurrentPart() {

    let index = 0;

    if (fs.existsSync(progressFile)) {

        const data = JSON.parse(
            fs.readFileSync(progressFile)
        );

        index = data.index || 0;
    }

    if (index >= parts.length) {
        index = 0;
    }

    const part = parts[index];

    if (!part) {

        throw new Error("לא נמצא חלק לשליחה");
    }

    return {
        index,
        message:
`📖 מסילת ישרים
יום ${index + 1} מתוך ${parts.length}

${part.title}

${part.text}`
    };
}

function advanceProgress(currentIndex) {

    fs.writeFileSync(
        progressFile,
        JSON.stringify({
            index: currentIndex + 1
        })
    );
}

// פונקציית השליחה
async function sendMessage(retry = true) {

    try {

        const now = new Date();
        const day = now.getDay();

        // שבת
        if (day === 6) {

            console.log("שבת - לא נשלחת הודעה");
            return false;
        }

        // בדיקת חיבור בסיסית
        if (!client.info || !client.pupPage) {

            console.log("הלקוח לא מחובר עדיין");
            return false;
        }

        // בדיקת מצב
        const state = await client.getState();

        if (state !== 'CONNECTED') {

            console.log("הלקוח לא מוכן לשליחה:", state);
            return false;
        }

        const groupId = '120363426627988217@g.us';

        const { index, message } = getCurrentPart();

        console.log("הודעה שנשלחת:");
        console.log(message);

        await client.sendMessage(groupId, message);

        console.log(`נשלח יום ${index + 1} בהצלחה`);

        // קידום רק אם הצליח
        advanceProgress(index);

        return true;

    } catch (err) {

        console.error("שגיאה בשליחה:", err);

        // detached frame
        if (
            retry &&
            err.message &&
            err.message.includes('detached')
        ) {

            console.log(
                "WhatsApp התרענן - ניסיון חוזר בעוד 5 דקות"
            );

            setTimeout(() => {

                sendMessage(false);

            }, 5 * 60 * 1000);
        }

        return false;
    }
}

// QR
let lastQRTime = 0;

client.on('qr', async (qr) => {

    const now = Date.now();

    if (now - lastQRTime < 2 * 60 * 1000) {

        console.log(
            "QR חדש התקבל אבל מדלגים (עדיין לא עברו 2 דקות)"
        );

        return;
    }

    lastQRTime = now;

    try {

        const qrImage = await QRcode.toDataURL(qr);

        console.log('\n--- סריקת הבוט לוואטסאפ ---');
        console.log('העתיקי את הקישור והדביקי בדפדפן:\n');
        console.log(qrImage);
        console.log('\n---------------------------\n');

    } catch (err) {

        console.error('שגיאה ביצירת QR:', err);
    }
});

// כשהבוט מוכן
client.on('ready', async () => {

    console.log('הבוט מוכן ומחובר!');

    // מניעת כמה schedulers
    if (!schedulerStarted) {

        schedulerStarted = true;

        scheduleDailyMessage();
    }
});

// תזמון הודעה יומית
function scheduleDailyMessage() {

    let nextSendTime;

    function calculateNextSendTime() {

        const now = new Date();

        const next = new Date();

        next.setHours(8, 0, 0, 0);

        if (now > next) {

            next.setDate(next.getDate() + 1);
        }

        nextSendTime = next;

        return next - now;
    }

    const delay = calculateNextSendTime();

    console.log(
        `הודעה ראשונה תישלח בעוד ${Math.round(delay / 1000 / 60)} דקות`
    );

    // הדפסה כל 10 דקות
    setInterval(() => {

        if (!nextSendTime) return;

        const now = new Date();

        const diff = nextSendTime - now;

        if (diff <= 0) return;

        const minutes = Math.floor(diff / 1000 / 60);

        console.log(
            `נשארו ${minutes} דקות לשליחה הבאה`
        );

    }, 10 * 60 * 1000);

    // שליחה ראשונה
    setTimeout(() => {

        sendMessage();

        // עדכון זמן
        nextSendTime = new Date();

        nextSendTime.setDate(
            nextSendTime.getDate() + 1
        );

        nextSendTime.setHours(8, 0, 0, 0);

        // שליחה יומית
        setInterval(() => {

            sendMessage();

            nextSendTime = new Date();

            nextSendTime.setDate(
                nextSendTime.getDate() + 1
            );

            nextSendTime.setHours(8, 0, 0, 0);

        }, 24 * 60 * 60 * 1000);

    }, delay);
}

// התנתקות
client.on('disconnected', async (reason) => {

    console.log('הבוט התנתק:', reason);

    try {

        console.log("מנסה להתחבר מחדש...");

        await client.destroy();

        setTimeout(() => {

            client.initialize();

        }, 10000);

    } catch (err) {

        console.log(
            "שגיאה בחיבור מחדש:",
            err.message
        );
    }
});

// הפעלה
client.initialize();