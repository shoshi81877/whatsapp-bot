console.log("הקובץ התחיל לרוץ");

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const QRcode = require('qrcode');

let schedulerStarted = false;

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: "./whatsapp-session"
    }),

    webVersionCache: {
        type: "none"
    },

    puppeteer: {
        executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-zygote"
        ]
    }
});

// טעינת הטקסט
const text = fs.readFileSync('mesilat.txt', 'utf-8');

// פיצול לפרקים
function splitChapters(text) {

    const lines = text.split('\n');

    let chapters = [];
    let currentTitle = '';
    let currentContent = [];

    for (let line of lines) {

        const trimmed = line.trim();

        // כותרת חדשה
        if (
            trimmed === 'הקדמה' ||
            /^פרק\s+[א-ת]+$/.test(trimmed)
        ) {

            // שמירת הקודם
            if (currentTitle) {

                chapters.push({
                    title: currentTitle,
                    content: currentContent.join('\n').trim()
                });
            }

            currentTitle = trimmed;
            currentContent = [];

        } else {

            currentContent.push(line);
        }
    }

    // האחרון
    if (currentTitle) {

        chapters.push({
            title: currentTitle,
            content: currentContent.join('\n').trim()
        });
    }

    return chapters;
}

// חלוקה חכמה בתוך פרק
function splitChapterToParts(chapterText, targetSize) {

    // ניקוי
    chapterText = chapterText.replace(/\r/g, '');

    // פיצול לפסקאות
    const paragraphs = chapterText
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean);

    let parts = [];
    let current = '';

    for (let paragraph of paragraphs) {

        // אם הפסקה עצמה ארוכה מדי
        if (paragraph.length > targetSize) {

            // חלוקה למשפטים
            const sentences = paragraph.match(
                /[^.!?:]+[.!?:]?/g
            ) || [paragraph];

            for (let sentence of sentences) {

                sentence = sentence.trim();

                // אם הוספת המשפט תחרוג
                if (
                    current.length + sentence.length >
                    targetSize
                ) {

                    // שומרים רק אם יש תוכן
                    if (current.trim()) {

                        parts.push(current.trim());
                    }

                    current = '';
                }

                current += sentence + ' ';
            }

        } else {

            // פסקה רגילה
            if (
                current.length + paragraph.length >
                targetSize
            ) {

                if (current.trim()) {

                    parts.push(current.trim());
                }

                current = '';
            }

            current += paragraph + '\n\n';
        }
    }

    // חלק אחרון
    if (current.trim()) {

        parts.push(current.trim());
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

const parts = buildAllParts(text);

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

    console.log("נכנס ל-sendMessage");

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

        console.log("state:", state);

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

    setTimeout(async () => {
        await sendMessage();
    }, 30000); // 30 שניות

    if (!schedulerStarted) {

        schedulerStarted = true;

        scheduleDailyMessage();
    }
});

// תזמון הודעה יומית
function scheduleDailyMessage() {

    console.log("Scheduler התחיל");

    // שליחה ראשונה אחרי 30 שניות
    //setTimeout(async () => {
//
    //    console.log("שולח הודעה ראשונה...");
//
    //    await sendMessage();
//
    //}, 30 * 1000);

    // בדיקה כל דקה
    setInterval(async () => {

        try {

            const now = new Date();

            const day = now.getDay();

            // שבת
            if (day === 6) {
                return;
            }

            const hour = now.getHours();
            const minute = now.getMinutes();

            // שליחה ב־08:00 בלבד
            if (hour === 8 && minute === 0) {

                console.log("הגיע זמן השליחה היומית");

                await sendMessage();
            }

        } catch (err) {

            console.log(
                "שגיאה ב-scheduler:",
                err.message
            );
        }

    }, 60 * 1000);
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