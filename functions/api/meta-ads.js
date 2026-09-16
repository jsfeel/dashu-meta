// functions/api/meta-ads.js
// Cloudflare Pages Functions: 이 파일은 자동으로 GET /api/meta-ads 엔드포인트가 됩니다.
// Meta Graph API(Marketing API)를 호출해 브랜드별(다슈/달리프/오하입) 캠페인 성과를 집계해서 내려줍니다.

const GRAPH_VERSION = "v21.0";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "dashu").toLowerCase();
  // range: today | yesterday | last_7d | last_14d | last_30d | this_month | last_month
  const range = url.searchParams.get("range") || "last_7d";

  const accountMap = {
    dashu: env.META_AD_ACCOUNT_DASHU,
    daleaf: env.META_AD_ACCOUNT_DALEAF,
    ohype: env.META_AD_ACCOUNT_OHYPE,
  };

  const adAccountId = accountMap[brand];
  if (!adAccountId) {
    return jsonResponse(
      { error: `알 수 없는 브랜드입니다: ${brand} (dashu / daleaf / ohype 중 하나여야 합니다)` },
      400
    );
  }

  const token = env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    return jsonResponse(
      { error: "META_SYSTEM_USER_TOKEN 환경변수가 설정되지 않았습니다. Cloudflare Pages 설정을 확인하세요." },
      500
    );
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
    `?level=campaign&date_preset=${range}&fields=${insightFields}&limit=200&access_token=${token}`;

  const campaignsUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${adAccountId}/campaigns` +
    `?fields=id,name,status,effective_status&limit=200&access_token=${token}`;

  try {
    const [insightsRes, campaignsRes] = await Promise.all([
      fetch(insightsUrl),
      fetch(campaignsUrl),
    ]);

    const insightsData = await insightsRes.json();
    const campaignsData = await campaignsRes.json();

    if (insightsData.error) throw new Error(insightsData.error.message);
    if (campaignsData.error) throw new Error(campaignsData.error.message);

    // 캠페인명 -> 상태 매핑 (insights 응답에는 상태 정보가 없어서 별도 조회)
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

    // 소진액 높은 순 정렬
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

    return jsonResponse({ brand, range, summary, campaigns, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
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
