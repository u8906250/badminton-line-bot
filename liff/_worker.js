// Pages 上的小轉接：把 pages.dev 的 /api/* 原封不動交給後端 Worker，其餘照常回靜態檔。
// env.API 是 Pages 專案設定裡的 service binding（指向 badminton-line-bot），是 Cloudflare 內部直接呼叫，不經過 workers.dev 的網址。
//
// 為什麼不讓頁面直接打 workers.dev：從台灣連 workers.dev 會被 Cloudflare 送到美國的機房（2026-10-13 實測是達拉斯，
// 一來一回約 0.2 秒），Worker 在美國執行，每查一次亞太區的資料庫又要跨一次太平洋，一個畫面因此要等一秒以上。
// pages.dev 是由台北的機房回應：請求從這裡進來，Worker 就在同一個機房執行；又和頁面同網域，瀏覽器不用先做跨網域的預檢。
//
// 這個檔案和 _routes.json 不會被當成靜態檔公開。_routes.json 限定只有 /api/* 會執行這支程式，靜態檔不佔用 Workers 的請求額度。
export default {
  fetch(request, env) {
    return new URL(request.url).pathname.startsWith('/api/') ? env.API.fetch(request) : env.ASSETS.fetch(request);
  },
};
