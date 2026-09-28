import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

// Client sends only what it wants judged; the key and model id stay here so
// they never reach the browser.
interface ProxyRequestBody {
  state: string;
  questions: Record<string, unknown>;
}

export async function jevRecommend(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    context.error("JEV_API_KEY is not configured");
    return { status: 500, jsonBody: { error: "Server misconfiguration" } };
  }

  let body: ProxyRequestBody;
  try {
    body = (await request.json()) as ProxyRequestBody;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be JSON" } };
  }

  if (typeof body.state !== "string" || typeof body.questions !== "object") {
    return { status: 400, jsonBody: { error: "Body must include 'state' (string) and 'questions' (object)" } };
  }

  const jevResponse = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: body.state,
      questions: body.questions,
    }),
  });

  const jevBody = await jevResponse.text();
  return {
    status: jevResponse.status,
    headers: { "Content-Type": "application/json" },
    body: jevBody,
  };
}

// "function" authLevel means the Azure Functions gateway itself rejects any
// request that doesn't carry a valid function key (x-functions-key header
// or ?code= query param) before it ever reaches our code -- so an
// anonymous caller can't spend Jev quota even if they find this URL.
app.http("jevRecommend", {
  methods: ["POST"],
  authLevel: "function",
  handler: jevRecommend,
});
