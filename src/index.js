/**
 * News Factory - Serverless Cloudflare Worker
 */

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		
		// CORS 헤더 설정
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// ── API 라우팅 ───────────────────────────────────────

			// 1. 초안 목록 가져오기
			if (url.pathname === '/api/drafts' && request.method === 'GET') {
				const { results } = await env.DB.prepare(
					"SELECT * FROM drafts ORDER BY created_at DESC"
				).all();
				return Response.json(results, { headers: corsHeaders });
			}

			// 2. URL 처리 시작 (가장 핵심!)
			if (url.pathname === '/api/process' && request.method === 'POST') {
				const { url: newsUrl } = await request.json();
				console.log(`[Process] URL 수신: ${newsUrl}`);

				// 이미 존재하는지 확인
				const existing = await env.DB.prepare("SELECT id FROM drafts WHERE url = ?")
					.bind(newsUrl).first();
				if (existing) {
					return Response.json({ status: 'error', message: '이미 등록된 뉴스입니다.' }, { status: 400, headers: corsHeaders });
				}

				// 기사 크롤링 (간이 버전)
				const article = await fetchArticle(newsUrl);
				
				// Gemini 호출 (요약 및 제목 생성)
				const aiResult = await generateWithGemini(article.title, article.content, env.GEMINI_API_KEY);

				// DB 저장
				const { lastRowId } = await env.DB.prepare(
					"INSERT INTO drafts (url, publisher, raw_title, raw_content, ai_title, ai_summary) VALUES (?, ?, ?, ?, ?, ?)"
				).bind(newsUrl, article.publisher, article.title, article.content, aiResult.title, aiResult.summary).run();

				return Response.json({ status: 'ok', id: lastRowId, ...aiResult }, { headers: corsHeaders });
			}

			// 3. 이미지 생성
			if (url.pathname.startsWith('/api/images/') && request.method === 'POST') {
				const id = url.pathname.split('/').pop();
				const draft = await env.DB.prepare("SELECT ai_title FROM drafts WHERE id = ?").bind(id).first();
				
				// 이미지 생성 API 호출 (여기서는 예시로 로직만 구성)
				// 실제로는 Imagen API 등을 호출합니다.
				const images = [`https://picsum.photos/seed/${id}1/1080/1080`, `https://picsum.photos/seed/${id}2/1080/1080`, `https://picsum.photos/seed/${id}3/1080/1080` ];
				
				await env.DB.prepare("UPDATE drafts SET image_paths = ? WHERE id = ?")
					.bind(JSON.stringify(images), id).run();
				
				return Response.json({ status: 'ok', images }, { headers: corsHeaders });
			}

			// 4. 인스타그램 업로드
			if (url.pathname.startsWith('/api/publish/') && request.method === 'POST') {
				const id = url.pathname.split('/').pop();
				const { selected_image } = await request.json();
				const draft = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first();

				// Instagram Graph API 호출 로직
				const success = await publishToInstagram(selected_image, `${draft.ai_title}\n\n${draft.ai_summary}`, env);

				if (success) {
					await env.DB.prepare("UPDATE drafts SET status = 'published', selected_image = ? WHERE id = ?")
						.bind(selected_image, id).run();
					return Response.json({ status: 'ok' }, { headers: corsHeaders });
				}
				return Response.json({ status: 'error', message: '인스타그램 업로드 실패' }, { status: 500, headers: corsHeaders });
			}

			// 5. 삭제
			if (url.pathname.startsWith('/api/drafts/') && request.method === 'DELETE') {
				const id = url.pathname.split('/').pop();
				await env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(id).run();
				return Response.json({ status: 'ok' }, { headers: corsHeaders });
			}

			// 6. 그 외 요청은 정적 자산(assets)으로 패스
			// Worker에서 처리하지 않은 경로는 public 폴더의 정적 파일을 찾아보도록 합니다.
			return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
		} catch (err) {
			return Response.json({ status: 'error', message: err.message }, { status: 500, headers: corsHeaders });
		}
	},
};

// ── 보조 함수들 ──────────────────────────────────────────────────

async function fetchArticle(url) {
	const res = await fetch(url, {
		headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }
	});
	const html = await res.text();
	
	// 제목 추출
	const titleMatch = html.match(/<title>(.*?)<\/title>/);
	const title = titleMatch ? titleMatch[1].split(' : ')[0] : "제목 없음";
	
	// 본문 추출 (매우 간단한 버전: p 태그들 결합)
	const pMatches = html.match(/<p[^>]*>(.*?)<\/p>/g);
	let content = pMatches ? pMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(t => t.length > 20).join('\n\n') : "본문을 가져올 수 없습니다.";
	
	// 본문이 너무 길면 자름
	if (content.length > 5000) content = content.substring(0, 5000) + "...";
	
	return {
		title: title.trim(),
		content: content.trim(),
		publisher: new URL(url).hostname,
	};
}

async function generateWithGemini(title, content, apiKey) {
	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
	
	const prompt = `뉴스 기사 제목: ${title}\n뉴스 본문: ${content}\n\n위 뉴스를 인스타그램 카드뉴스 형태로 요약해줘. 형식: { "title": "강렬한 제목", "summary": "3줄 요약" } (JSON으로 응답)`;
	
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: jsonBody(prompt)
	});
	
	const data = await res.json();
	if (!data.candidates || data.candidates.length === 0) return { title: "요약 실패", summary: "AI 분석에 실패했습니다." };
	const text = data.candidates[0].content.parts[0].text;
	return JSON.parse(text.replace(/```json|```/g, ""));
}

function jsonBody(prompt) {
	return JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
}

async function publishToInstagram(imageUrl, caption, env) {
	// 실제 Instagram API 호출 로직은 기존 파이썬 코드를 JS fetch로 변환하여 작성
	// (토큰 정보는 env.INSTAGRAM_ACCESS_TOKEN 등에서 가져옴)
	console.log(`[Instagram] 업로드 시도: ${imageUrl}`);
	return true; // 테스트를 위해 항상 성공 반환
}
