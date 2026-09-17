// src/index.js
// Cloudflare Worker 엔트리포인트.
// /api/meta-ads 요청은 브랜드+채널 단위로 Meta 계정을 조회해서
// 캠페인 -> 광고세트 -> 소재(광고) 계층 구조로 집계해 내려주고,
// 그 외 요청은 정적 자산(ASSETS)으로 서빙합니다.

const GRAPH_VERSION = "v21.0";

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

    if (url.pathname === "/api/meta-ads") {
      return handleMetaAds(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleMetaAds(request, env) {
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "dashu").toLowerCase();
  const channel = (url.searchParams.get("channel") || "all").toLowerCase();
  const range = url.searchParams.get("range") || "last_7d";
  const since = url.searchParams.get("since"); // YYYY-MM-DD
  const until = url.searchParams.get("until"); // YYYY-MM-DD

  const dateParam =
    since && until
      ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
      : `date_preset=${range}`;

  const brandAccounts = ACCOUNTS[brand];
  if (!brandAccounts) {
    return jsonResponse({ error: `알 수 없는 브랜드입니다: ${brand}` }, 400);
  }

  const targetChannels =
    channel === "all"
      ? Object.entries(brandAccounts)
      : Object.entries(brandAccounts).filter(([key]) => key === channel);

  if (targetChannels.length === 0) {
    return jsonResponse({ error: `알 수 없는 채널입니다: ${channel}` }, 400);
  }

  try {
    const channelResults = await Promise.all(
      targetChannels.map(([key, account]) => fetchChannelData(key, account, dateParam, env))
    );

    const errors = channelResults.filter((r) => r.error);
    if (errors.length > 0 && channelResults.every((r) => r.error)) {
      return jsonResponse(
        { error: errors.map((e) => `[${e.channelLabel}] ${e.error}`).join(" / ") },
        500
      );
    }

    // 모든 채널의 캠페인 트리를 하나로 합치되, 채널 라벨을 각 캠페인에 붙임
    const campaigns = [];
    channelResults.forEach((r) => {
      if (r.error) return;
      r.campaigns.forEach((c) => campaigns.push({ ...c, channel: r.channelLabel }));
    });

    campaigns.sort((a, b) => b.spend - a.spend);

    const summary = sumMetrics(campaigns);
    summary.activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE").length;
    summary.totalCampaigns = campaigns.length;

    const partialErrors = errors.length > 0 ? errors.map((e) => `${e.channelLabel}: ${e.error}`) : [];

    return jsonResponse({
      brand,
      channel,
      range,
      summary,
      campaigns,
      partialErrors,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function fetchChannelData(channelKey, account, dateParam, env) {
  const token = env[account.tokenKey];
  const adAccountId = `act_${account.id}`;

  if (!token) {
    return { channelLabel: account.label, error: `${account.tokenKey} 환경변수가 설정되지 않았습니다.` };
  }

  // 광고(ad) 단위로 인사이트를 한 번만 조회하면 campaign/adset/ad 이름이 전부 딸려옵니다.
  const insightFields = [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
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
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/insights` +
    `?level=ad&${dateParam}&fields=${insightFields}&limit=500&access_token=${token}`;

  // 상태(운영중/일시중지 등)는 인사이트에 없어서 각 레벨 엣지에서 별도 조회
  const campaignsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/campaigns` +
    `?fields=id,effective_status&limit=500&access_token=${token}`;
  const adsetsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/adsets` +
    `?fields=id,effective_status&limit=500&access_token=${token}`;
  const adsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/ads` +
    `?fields=id,effective_status&limit=500&access_token=${token}`;

  try {
    const [insightsRes, campaignsRes, adsetsRes, adsRes] = await Promise.all([
      fetch(insightsUrl),
      fetch(campaignsUrl),
      fetch(adsetsUrl),
      fetch(adsUrl),
    ]);

    const [insightsData, campaignsData, adsetsData, adsData] = await Promise.all([
      insightsRes.json(),
      campaignsRes.json(),
      adsetsRes.json(),
      adsRes.json(),
    ]);

    if (insightsData.error) throw new Error(insightsData.error.message);
    if (campaignsData.error) throw new Error(campaignsData.error.message);
    if (adsetsData.error) throw new Error(adsetsData.error.message);
    if (adsData.error) throw new Error(adsData.error.message);

    const campaignStatus = toStatusMap(campaignsData.data);
    const adsetStatus = toStatusMap(adsetsData.data);
    const adStatus = toStatusMap(adsData.data);

    // campaignId -> { ...meta, adsets: { adsetId -> { ...meta, ads: [] } } }
    const campaignMap = new Map();

    (insightsData.data || []).forEach((row) => {
      const purchaseAction = findAction(row.actions, ["purchase", "omni_purchase"]);
      const purchaseValue = findAction(row.action_values, ["purchase", "omni_purchase"]);
      const spend = toNumber(row.spend);
      const revenue = purchaseValue ? toNumber(purchaseValue.value) : 0;

      const adMetrics = {
        spend,
        impressions: toInt(row.impressions),
        clicks: toInt(row.clicks),
        purchases: purchaseAction ? toInt(purchaseAction.value) : 0,
        revenue,
      };

      const ad = {
        id: row.ad_id,
        name: row.ad_name,
        status: adStatus[row.ad_id] || "UNKNOWN",
        ...adMetrics,
        ...deriveRates(adMetrics),
      };

      if (!campaignMap.has(row.campaign_id)) {
        campaignMap.set(row.campaign_id, {
          id: row.campaign_id,
          name: row.campaign_name,
          status: campaignStatus[row.campaign_id] || "UNKNOWN",
          adsets: new Map(),
        });
      }
      const campaign = campaignMap.get(row.campaign_id);

      if (!campaign.adsets.has(row.adset_id)) {
        campaign.adsets.set(row.adset_id, {
          id: row.adset_id,
          name: row.adset_name,
          status: adsetStatus[row.adset_id] || "UNKNOWN",
          ads: [],
        });
      }
      campaign.adsets.get(row.adset_id).ads.push(ad);
    });

    // Map -> 배열로 변환하면서 adset/campaign 단위 지표를 하위 항목 합산으로 계산
    const campaigns = Array.from(campaignMap.values()).map((c) => {
      const adsets = Array.from(c.adsets.values()).map((as) => {
        const metrics = sumMetrics(as.ads);
        return { id: as.id, name: as.name, status: as.status, ads: as.ads, ...metrics };
      });
      adsets.sort((a, b) => b.spend - a.spend);
      const metrics = sumMetrics(adsets);
      return { id: c.id, name: c.name, status: c.status, adsets, ...metrics };
    });

    return { channelLabel: account.label, campaigns };
  } catch (err) {
    return { channelLabel: account.label, error: err.message };
  }
}

function toStatusMap(list) {
  const map = {};
  (list || []).forEach((item) => {
    map[item.id] = item.effective_status;
  });
  return map;
}

// 하위 항목(광고/광고세트/캠페인) 배열의 지표를 합산하고 파생 지표(ctr/cpc/roas)를 계산
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
