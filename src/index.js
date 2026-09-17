// src/index.js
// Cloudflare Worker 엔트리포인트.
//
// 지연 로딩(lazy load) 구조:
//   GET /api/meta-ads                -> 캠페인 목록만 조회 (빠름)
//   GET /api/meta-ads/adsets         -> 특정 캠페인의 광고세트 목록 조회 (캠페인 클릭 시)
//   GET /api/meta-ads/ads            -> 특정 광고세트의 소재(광고) 목록 조회 (광고세트 클릭 시)
// 그 외 요청은 정적 자산(ASSETS)으로 서빙합니다.

const GRAPH_VERSION = "v21.0";

// 소재 판단 기본 기준값 (필요시 여기서만 조정하면 전체에 반영됨)
const JUDGMENT = {
  TARGET_ROAS: 2.0, // 이 값 이상이면 "효율 양호"
  CTR_DROP_RATIO: 0.2, // 최근 3일 평균 CTR이 초반 3일 대비 이 비율(20%) 이상 하락하면 피로 신호에 포함
  FATIGUE_FREQUENCY: 1.3, // 빈도가 이 값 이상이면 피로 신호에 포함
};

// 브랜드별 채널 -> 광고계정ID / 사용 토큰 매핑
// tokenKey는 env에 등록한 시크릿 이름과 매칭됩니다 (META_TOKEN_A ~ META_TOKEN_E)
const ACCOUNTS = {
  dashu: {
    own: { label: "자사몰", id: "1050049725490173", tokenKey: "META_TOKEN_A" },
    musinsa: { label: "무신사", id: "25364354183208099", tokenKey: "META_TOKEN_A" },
    naver: { label: "네이버", id: "2427397720929274", tokenKey: "META_TOKEN_A" },
    oy: { label: "올리브영", id: "445510651113935", tokenKey: "META_TOKEN_B" },
  },
  daleaf: {
    own: { label: "자사몰", id: "228877692038611", tokenKey: "META_TOKEN_C" },
    oy: { label: "올리브영", id: "526730309300564", tokenKey: "META_TOKEN_C" },
    musinsa: { label: "무신사", id: "1323555023149392", tokenKey: "META_TOKEN_C" },
    naver: { label: "네이버", id: "1680235736266080", tokenKey: "META_TOKEN_C" },
  },
  fleef: {
    own: { label: "자사몰", id: "430461658228713", tokenKey: "META_TOKEN_D" },
    oy: { label: "올리브영", id: "1639289507340496", tokenKey: "META_TOKEN_D" },
    musinsa: { label: "무신사", id: "26648421291443213", tokenKey: "META_TOKEN_D" },
    naver: { label: "네이버", id: "1210270207595993", tokenKey: "META_TOKEN_D" },
  },
  ohype: {
    own: { label: "자사몰", id: "2027060737905816", tokenKey: "META_TOKEN_E" },
    oy: { label: "올리브영", id: "979081524998885", tokenKey: "META_TOKEN_E" },
    musinsa: { label: "무신사", id: "1214092327278935", tokenKey: "META_TOKEN_E" },
    "29cm": { label: "29CM", id: "1717471413009405", tokenKey: "META_TOKEN_E" },
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/meta-ads") return handleCampaigns(request, env);
    if (url.pathname === "/api/meta-ads/adsets") return handleAdsets(request, env);
    if (url.pathname === "/api/meta-ads/ads") return handleAds(request, env);
    if (url.pathname === "/api/meta-ads/ad-detail") return handleAdDetail(request, env);

    return env.ASSETS.fetch(request);
  },
};

function getDateParam(url) {
  const range = url.searchParams.get("range") || "last_7d";
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  return since && until
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=${range}`;
}

function getToken(env, brand, channelKey) {
  const account = ACCOUNTS[brand] && ACCOUNTS[brand][channelKey];
  if (!account) return { error: `알 수 없는 브랜드/채널입니다: ${brand}/${channelKey}` };
  const token = env[account.tokenKey];
  if (!token) return { error: `${account.tokenKey} 환경변수가 설정되지 않았습니다.` };
  return { token, account };
}

// ---------- 1) 캠페인 목록 (지연 로딩의 최초 화면) ----------
async function handleCampaigns(request, env) {
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "dashu").toLowerCase();
  const channel = (url.searchParams.get("channel") || "all").toLowerCase();
  const dateParam = getDateParam(url);

  const brandAccounts = ACCOUNTS[brand];
  if (!brandAccounts) return jsonResponse({ error: `알 수 없는 브랜드입니다: ${brand}` }, 400);

  const targetChannels =
    channel === "all"
      ? Object.entries(brandAccounts)
      : Object.entries(brandAccounts).filter(([key]) => key === channel);

  if (targetChannels.length === 0) {
    return jsonResponse({ error: `알 수 없는 채널입니다: ${channel}` }, 400);
  }

  try {
    // 채널을 동시에 다 조회하면 Cloudflare/Meta 쪽 동시 연결·요청 한도에 걸릴 수 있어 순차 처리
    const channelResults = [];
    for (const [channelKey, account] of targetChannels) {
      const result = await fetchCampaignsForChannel(channelKey, account, dateParam, env);
      channelResults.push(result);
    }

    const errors = channelResults.filter((r) => r.error);
    if (errors.length > 0 && channelResults.every((r) => r.error)) {
      return jsonResponse(
        { error: errors.map((e) => `[${e.channelLabel}] ${e.error}`).join(" / ") },
        500
      );
    }

    const campaigns = [];
    channelResults.forEach((r) => {
      if (r.error) return;
      r.campaigns.forEach((c) => campaigns.push({ ...c, channel: r.channelLabel, channelKey: r.channelKey }));
    });

    campaigns.sort((a, b) => b.spend - a.spend);

    const summary = sumMetrics(campaigns);
    summary.activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE").length;
    summary.totalCampaigns = campaigns.length;

    const partialErrors = errors.length > 0 ? errors.map((e) => `${e.channelLabel}: ${e.error}`) : [];

    return jsonResponse({
      brand,
      channel,
      summary,
      campaigns,
      partialErrors,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function fetchCampaignsForChannel(channelKey, account, dateParam, env) {
  const token = env[account.tokenKey];
  if (!token) {
    return { channelLabel: account.label, channelKey, error: `${account.tokenKey} 환경변수가 설정되지 않았습니다.` };
  }
  const adAccountId = `act_${account.id}`;

  const insightFields = [
    "campaign_id",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "actions",
    "action_values",
  ].join(",");

  const insightsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/insights` +
    `?level=campaign&${dateParam}&fields=${insightFields}&limit=500&access_token=${token}`;
  const campaignsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/campaigns` +
    `?fields=id,effective_status&limit=500&access_token=${token}`;

  try {
    const [insightsRes, campaignsRes] = await Promise.all([fetch(insightsUrl), fetch(campaignsUrl)]);
    const [insightsData, campaignsData] = await Promise.all([insightsRes.json(), campaignsRes.json()]);

    if (insightsData.error) throw new Error(insightsData.error.message);
    if (campaignsData.error) throw new Error(campaignsData.error.message);

    const statusMap = toStatusMap(campaignsData.data);

    const campaigns = (insightsData.data || []).map((row) => {
      const m = extractMetrics(row);
      return {
        id: row.campaign_id,
        name: row.campaign_name,
        status: statusMap[row.campaign_id] || "UNKNOWN",
        ...m,
        ...deriveRates(m),
      };
    });

    return { channelLabel: account.label, channelKey, campaigns };
  } catch (err) {
    return { channelLabel: account.label, channelKey, error: err.message };
  }
}

// ---------- 2) 특정 캠페인의 광고세트 목록 (캠페인 클릭 시) ----------
async function handleAdsets(request, env) {
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "").toLowerCase();
  const channel = (url.searchParams.get("channel") || "").toLowerCase();
  const campaignId = url.searchParams.get("campaignId");
  const dateParam = getDateParam(url);

  if (!campaignId) return jsonResponse({ error: "campaignId가 필요합니다." }, 400);

  const { token, error } = getToken(env, brand, channel);
  if (error) return jsonResponse({ error }, 400);

  const insightFields = [
    "adset_id",
    "adset_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "actions",
    "action_values",
  ].join(",");

  const insightsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${campaignId}/insights` +
    `?level=adset&${dateParam}&fields=${insightFields}&limit=500&access_token=${token}`;
  const adsetsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${campaignId}/adsets` +
    `?fields=id,effective_status&limit=500&access_token=${token}`;

  try {
    const [insightsRes, adsetsRes] = await Promise.all([fetch(insightsUrl), fetch(adsetsUrl)]);
    const [insightsData, adsetsData] = await Promise.all([insightsRes.json(), adsetsRes.json()]);

    if (insightsData.error) throw new Error(insightsData.error.message);
    if (adsetsData.error) throw new Error(adsetsData.error.message);

    const statusMap = toStatusMap(adsetsData.data);

    const adsets = (insightsData.data || []).map((row) => {
      const m = extractMetrics(row);
      return {
        id: row.adset_id,
        name: row.adset_name,
        status: statusMap[row.adset_id] || "UNKNOWN",
        ...m,
        ...deriveRates(m),
      };
    });

    adsets.sort((a, b) => b.spend - a.spend);

    return jsonResponse({ adsets, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ---------- 3) 특정 광고세트의 소재(광고) 목록 (광고세트 클릭 시) ----------
async function handleAds(request, env) {
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "").toLowerCase();
  const channel = (url.searchParams.get("channel") || "").toLowerCase();
  const adsetId = url.searchParams.get("adsetId");
  const dateParam = getDateParam(url);

  if (!adsetId) return jsonResponse({ error: "adsetId가 필요합니다." }, 400);

  const { token, error } = getToken(env, brand, channel);
  if (error) return jsonResponse({ error }, 400);

  const insightFields = [
    "ad_id",
    "ad_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "actions",
    "action_values",
  ].join(",");

  const insightsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adsetId}/insights` +
    `?level=ad&${dateParam}&fields=${insightFields}&limit=500&access_token=${token}`;
  const adsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adsetId}/ads` +
    `?fields=id,effective_status&limit=500&access_token=${token}`;

  try {
    const [insightsRes, adsRes] = await Promise.all([fetch(insightsUrl), fetch(adsUrl)]);
    const [insightsData, adsData] = await Promise.all([insightsRes.json(), adsRes.json()]);

    if (insightsData.error) throw new Error(insightsData.error.message);
    if (adsData.error) throw new Error(adsData.error.message);

    const statusMap = toStatusMap(adsData.data);

    const ads = (insightsData.data || []).map((row) => {
      const m = extractMetrics(row);
      return {
        id: row.ad_id,
        name: row.ad_name,
        status: statusMap[row.ad_id] || "UNKNOWN",
        ...m,
        ...deriveRates(m),
      };
    });

    ads.sort((a, b) => b.spend - a.spend);

    return jsonResponse({ ads, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ---------- 4) 소재 상세 (일별 추이 + 효율/피로 판단) ----------
async function handleAdDetail(request, env) {
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "").toLowerCase();
  const channel = (url.searchParams.get("channel") || "").toLowerCase();
  const adId = url.searchParams.get("adId");
  const dateParam = getDateParam(url);

  if (!adId) return jsonResponse({ error: "adId가 필요합니다." }, 400);

  const { token, error } = getToken(env, brand, channel);
  if (error) return jsonResponse({ error }, 400);

  const dailyFields = ["spend", "impressions", "clicks", "ctr", "frequency", "actions", "action_values"].join(",");

  const adInfoUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${adId}?fields=id,name,effective_status,created_time&access_token=${token}`;
  const dailyUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adId}/insights` +
    `?${dateParam}&time_increment=1&fields=${dailyFields}&limit=500&access_token=${token}`;

  try {
    const [adInfoRes, dailyRes] = await Promise.all([fetch(adInfoUrl), fetch(dailyUrl)]);
    const [adInfo, dailyData] = await Promise.all([adInfoRes.json(), dailyRes.json()]);

    if (adInfo.error) throw new Error(adInfo.error.message);
    if (dailyData.error) throw new Error(dailyData.error.message);

    const daily = (dailyData.data || [])
      .map((row) => {
        const m = extractMetrics(row);
        return {
          date: row.date_start,
          frequency: toNumber(row.frequency),
          ...m,
          ...deriveRates(m),
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const totals = sumMetrics(daily);
    const latestFrequency = daily.length ? daily[daily.length - 1].frequency : 0;
    const cpa = totals.purchases > 0 ? totals.spend / totals.purchases : null;

    // 피로도: 초반 3일 vs 최근 3일 평균 CTR 비교
    const earlyDays = daily.slice(0, 3);
    const recentDays = daily.slice(Math.max(0, daily.length - 3));
    const avgCtr = (arr) => (arr.length ? arr.reduce((s, d) => s + d.ctr, 0) / arr.length : 0);
    const earlyCtr = avgCtr(earlyDays);
    const recentCtr = avgCtr(recentDays);
    const ctrDropRatio = earlyCtr > 0 ? (earlyCtr - recentCtr) / earlyCtr : 0;
    const fatigued = ctrDropRatio >= JUDGMENT.CTR_DROP_RATIO && latestFrequency >= JUDGMENT.FATIGUE_FREQUENCY;
    const efficient = totals.roas >= JUDGMENT.TARGET_ROAS;

    const judgment = buildJudgment(efficient, fatigued);

    // 수명: 생성일 -> 첫 지출일 -> 마지막 지출일
    const createdDate = adInfo.created_time ? adInfo.created_time.slice(0, 10) : null;
    const spendDays = daily.filter((d) => d.spend > 0);
    const firstSpendDate = spendDays.length ? spendDays[0].date : null;
    const lastSpendDate = spendDays.length ? spendDays[spendDays.length - 1].date : null;
    const daysBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 86400000) : null);

    return jsonResponse({
      id: adInfo.id,
      name: adInfo.name,
      status: adInfo.effective_status,
      createdDate,
      summary: {
        spend: totals.spend,
        revenue: totals.revenue,
        roas: totals.roas,
        ctr: totals.ctr,
        cpa,
        frequency: latestFrequency,
        purchases: totals.purchases,
      },
      daily,
      fatigue: {
        earlyCtr,
        recentCtr,
        ctrDropRatio,
        frequency: latestFrequency,
        fatigued,
      },
      judgment,
      lifespan: {
        createdDate,
        firstSpendDate,
        lastSpendDate,
        daysCreatedToFirstSpend: daysBetween(createdDate, firstSpendDate),
        daysFirstToLastSpend: daysBetween(firstSpendDate, lastSpendDate),
        daysRunning: daysBetween(createdDate, new Date().toISOString().slice(0, 10)),
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function buildJudgment(efficient, fatigued) {
  if (efficient && !fatigued) return { efficient, fatigued, label: "효율 양호", action: "증액 테스트", tone: "good" };
  if (efficient && fatigued) return { efficient, fatigued, label: "효율 양호", action: "소재 교체 준비 후 유지", tone: "warn" };
  if (!efficient && fatigued) return { efficient, fatigued, label: "효율 우려", action: "즉시 교체 검토", tone: "bad" };
  return { efficient, fatigued, label: "효율 우려", action: "타겟팅·소재 점검 필요", tone: "bad" };
}

// ---------- 공통 유틸 ----------
function toStatusMap(list) {
  const map = {};
  (list || []).forEach((item) => {
    map[item.id] = item.effective_status;
  });
  return map;
}

function extractMetrics(row) {
  const purchaseAction = findAction(row.actions, ["purchase", "omni_purchase"]);
  const purchaseValue = findAction(row.action_values, ["purchase", "omni_purchase"]);
  return {
    spend: toNumber(row.spend),
    impressions: toInt(row.impressions),
    clicks: toInt(row.clicks),
    purchases: purchaseAction ? toInt(purchaseAction.value) : 0,
    revenue: purchaseValue ? toNumber(purchaseValue.value) : 0,
  };
}

function sumMetrics(items) {
  const totals = items.reduce(
    (acc, item) => {
      acc.spend += item.spend;
      acc.impressions += item.impressions;
      acc.clicks += item.clicks;
      acc.purchases += item.purchases;
      acc.revenue += item.revenue;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 }
  );
  return { ...totals, ...deriveRates(totals) };
}

function deriveRates(m) {
  return {
    ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0,
    cpc: m.clicks > 0 ? m.spend / m.clicks : 0,
    roas: m.spend > 0 ? m.revenue / m.spend : 0,
  };
}

function findAction(list, types) {
  if (!Array.isArray(list)) return null;
  return list.find((a) => types.includes(a.action_type));
}

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
