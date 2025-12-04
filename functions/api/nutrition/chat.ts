m.post("/api/nutrition/chat", async (c) => {
  try {
    // ננסה לקרוא body כ JSON, ואם נכשל נקבל אובייקט ריק
    let body = {};
    try {
      body = await c.req.json();
    } catch (e) {
      body = {};
    }

    // פורמט ישן: message + history + userId
    let message = body.message;
    let history = Array.isArray(body.history) ? body.history : [];

    // פורמט חדש של GPTs: messages = [{ role, content }]
    const messagesFromClient = Array.isArray(body.messages) ? body.messages : [];

    // אם אין message רגיל אבל כן יש messages מה GPT
    if (!message && messagesFromClient.length > 0) {
      // ניקח את ההודעה האחרונה של המשתמש כטקסט
      const lastUser = [...messagesFromClient]
        .reverse()
        .find(
          (m) =>
            m &&
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.trim() !== ""
        );

      if (lastUser) {
        message = lastUser.content;
      }

      // כל מה שלפני האחרונה ייחשב כהיסטוריה
      history = messagesFromClient
        .slice(0, -1)
        .filter(
          (m) =>
            m &&
            typeof m.role === "string" &&
            typeof m.content === "string"
        )
        .map((m) => ({
          role: m.role,
          content: m.content
        }));
    }

    // אם אחרי כל זה עדיין אין הודעה או שהטקסט ריק
    if (!message || !String(message).trim()) {
      return c.json({ error: "הודעה ריקה" }, 400);
    }

    const apiKey = c.env.OPENAI_API_KEY || "";
	console.log("DEBUG OPENAI_API_KEY exists:", !!c.env.OPENAI_API_KEY);
    if (!apiKey) {
      const fallback =
        "⚠️ מערכת התזונה עדיין לא הוגדרה במלואה.\n\n" +
        "כדי להפעיל את הצ'אט התזונתי ב-JumpFitPro:\n" +
        "1. קבל OpenAI API Key.\n" +
        "2. הוסף אותו כ-secret בשם OPENAI_API_KEY ב-Wrangler.\n" +
        "3. פרוס מחדש את הפרויקט.\n\n" +
        "בינתיים אפשר לשמור את השאלות ולהשתמש בהן אחר כך.";

      // מחזירים reply כדי להתאים ל-GPTs
      return c.json({ reply: fallback });
    }

    // ניסיון למשוך פרטי משתמש אם יש userId (פורמט ישן מהדשבורד)
    const userId = body.userId;
    let profile = null;

    if (userId) {
      try {
        profile = await c.env.DB.prepare(
          `
          SELECT name, age, gender, weight_kg, target_weight_kg, height_cm, current_level
          FROM users
          WHERE id = ?
        `
        )
          .bind(userId)
          .first();
      } catch (err) {
        console.error("DB error in /api/nutrition/chat:", err);
      }
    }

    const genderText =
      profile && profile.gender === "male"
        ? "זכר"
        : profile && profile.gender === "female"
        ? "נקבה"
        : "לא ידוע";

    const systemPrompt =
      `אתה מומחה תזונה ישראלי. המשתמש שלך הוא ${
        (profile && profile.name) || "משתמש"
      }:\n` +
      `- גיל: ${(profile && profile.age) ?? "לא ידוע"}\n` +
      `- מין: ${genderText}\n` +
      `- משקל נוכחי: ${
        (profile && profile.weight_kg) ?? "לא ידוע"
      } ק"ג\n` +
      `- משקל יעד: ${
        (profile && profile.target_weight_kg) ?? "לא ידוע"
      } ק"ג\n` +
      `- רמת כושר: ${
        (profile && profile.current_level) ?? "לא ידוע"
      }\n\n` +
      `תן המלצות תזונה מותאמות אישית, מתכונים בעברית, וחשב קלוריות כשצריך.\n` +
      `השתמש בשפה חמה, ברורה ופשוטה.`;

    // בניית רשימת הודעות ל-OpenAI
    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...(Array.isArray(history) ? history : []).map((m) => ({
        role:
          m.role === "user" ||
          m.role === "assistant" ||
          m.role === "system"
            ? m.role
            : "user",
        content: String(m.content ?? "")
      })),
      {
        role: "user",
        content: String(message)
      }
    ];

    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: openaiMessages,
          temperature: 0.7,
          max_tokens: 1000
        })
      }
    );

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI API error:", errText);

      return c.json({
        reply:
          "מצטער, קרתה שגיאה בזמן יצירת תשובת התזונה. נסה שוב מאוחר יותר."
      });
    }

    const data = await openaiRes.json();
    const reply =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content
        : "לא הצלחתי לקבל תשובה מהמודל, נסה שוב.";

    // מחזירים reply (ל-GPTs) וגם response/success (ל-JumpFitPro אם צריך)
    return c.json({
      success: true,
      response: reply,
      reply
    });
  } catch (err) {
    console.error("Nutrition chat error:", err);
    const msg =
      "מצטער, אירעה שגיאה פנימית במערכת התזונה. אם זה חוזר על עצמו, עדכן את מנהל המערכת.";

    return c.json({ reply: msg });
  }
});
