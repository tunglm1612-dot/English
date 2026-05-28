export default async (request) => {
  if (request.method !== "POST") return Response.json({error:"POST only"}, {status:405});
  try {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    const results = await Promise.all(items.map(async item => {
      const id = String(item.id || "");
      const query = String(item.query || "").trim();
      if (!id || !query) return {id, error:"Invalid item"};
      try {
        const url = new URL("https://translate.googleapis.com/translate_a/single");
        url.search = new URLSearchParams({client:"gtx", sl:"en", tl:"vi", dt:"t", q:query}).toString();
        const response = await fetch(url, {headers:{"User-Agent":"Oxford-Vocab-Together/2.0"}});
        if (!response.ok) throw new Error("translate failed");
        const payload = await response.json();
        const vi = (payload?.[0] || []).map(chunk => chunk?.[0] || "").join("").trim();
        return {id, vi};
      } catch {
        return {id, error:"Không tải được nghĩa tự động."};
      }
    }));
    return Response.json({results});
  } catch {
    return Response.json({error:"Dữ liệu không hợp lệ."}, {status:400});
  }
};