// src/index.js
// Cloudflare Worker 엔트리포인트.
// /api/meta-ads 요청은 브랜드+채널 단위로 Meta 계정을 조회/집계해서 내려주고,
// 그 외 요청은 정적 자산(ASSETS)으로 서빙합니다.

const GRAPH_VERSION = "v21.0";

// 브랜드별 채널 -> 광고계정ID / 사용 토큰 매핑
// tokenKey는 env에 등록한 시크릿 이름과 매칭됩니다 (META_TOKEN_A / META_TOKEN_B)
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

  // since/until이 둘 다 있으면 커스텀 기간(time_range)을 우선 사용, 없으면 range(date_preset) 사용
  const dateParam =
    since && until
      ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
      : `date_preset=${range}`;

  const brandAccounts = ACCOUNTS[brand];
  if (!brandAccounts) {
    return jsonResponse({ error: `알 수 없는 브랜드입니다: ${brand}` }, 400);
  }

  // channel=all이면 해당 브랜드의 모든 채널을 대상으로, 아니면 지정된 채널 하나만
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

    // 에러가 하나라도 있으면 어떤 채널인지 표시해서 반환
    const errors = channelResults.filter((r) => r.error);
    if (errors.length > 0 && channelResults.every((r) => r.error)) {
      // 모든 채널이 실패한 경우에만 전체 에러로 처리
      return jsonResponse(
        { error: errors.map((e) => `[${e.channelLabel}] ${e.error}`).join(" / ") },
        500
      );
    }

    // 모든 채널의 캠페인을 하나로 합치되, 채널 라벨을 각 캠페인에 붙임
    const campaigns = [];
    channelResults.forEach((r) => {
      if (r.error) return; // 부분 실패는 건너뛰고 나머지로 계속 진행
      r.campaigns.forEach((c) => campaigns.push({ ...c, channel: r.channelLabel }));
    });

    campaigns.sort((a, b) => b.spend - a.spend);

    const summary = campaigns.reduce(
      (acc, c) => {
        acc.spend += c.spend;
        acc.impressions += c.impressions;
        acc.clicks += c.clicks;
        acc.purchases += c.purchases;
        acc.revenue += c.revenue;
        return acc;
      },
      { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 }
    );
    summary.ctr = summary.impressions > 0 ? (summary.clicks / summary.impressions) * 100 : 0;
    summary.cpc = summary.clicks > 0 ? summary.spend / summary.clicks : 0;
    summary.roas = summary.spend > 0 ? summary.revenue / summary.spend : 0;
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

  const insightFields = [
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
    `?level=campaign&${dateParam}&fields=${insightFields}&limit=200&access_token=${token}`;

  const campaignsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/campaigns` +
    `?fields=id,name,status,effective_status&limit=200&access_token=${token}`;

  try {
    const [insightsRes, campaignsRes] = await Promise.all([fetch(insightsUrl), fetch(campaignsUrl)]);
    const insightsData = await insightsRes.json();
    const campaignsData = await campaignsRes.json();

    if (insightsData.error) throw new Error(insightsData.error.message);
    if (campaignsData.error) throw new Error(campaignsData.error.message);

    const statusMap = {};
    (campaignsData.data || []).forEach((c) => {
      statusMap[c.name] = c.effective_status;
    });

    const campaigns = (insightsData.data || []).map((row) => {
      const purchaseAction = findAction(row.actions, ["purchase", "omni_purchase"]);
      const purchaseValue = findAction(row.action_values, ["purchase", "omni_purchase"]);
      const spend = toNumber(row.spend);
      const revenue = purchaseValue ? toNumber(purchaseValue.value) : 0;

      return {
        name: row.campaign_name,
        status: statusMap[row.campaign_name] || "UNKNOWN",
        spend,
        impressions: toInt(row.impressions),
        clicks: toInt(row.clicks),
        ctr: toNumber(row.ctr),
        cpc: toNumber(row.cpc),
        cpm: toNumber(row.cpm),
        purchases: purchaseAction ? toInt(purchaseAction.value) : 0,
        revenue,
        roas: spend > 0 ? revenue / spend : 0,
      };
    });

    return { channelLabel: account.label, campaigns };
  } catch (err) {
    return { channelLabel: account.label, error: err.message };
  }
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
