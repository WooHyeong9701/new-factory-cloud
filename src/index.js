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
				// DB 저장
				const { lastRowId } = await env.DB.prepare(
					"INSERT INTO drafts (url, publisher, raw_title, raw_content, ai_title, ai_summary) VALUES (?, ?, ?, ?, ?, ?)"
				).bind(newsUrl, article.publisher, article.title, article.content, aiResult.title, aiResult.summary).run();

				return Response.json({ 
					status: 'ok', 
					id: lastRowId, 
					raw_title: article.title,
					raw_content: article.content,
					ai_title: aiResult.title,
					ai_summary: aiResult.summary
				}, { headers: corsHeaders });
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
	console.log(`[Crawler] Fetching: ${url}`);
	const res = await fetch(url, {
		headers: { 
			'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
			'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
			'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
		},
		redirect: 'follow'
	});

	if (!res.ok) throw new Error(`사이트 접속 실패 (Status: ${res.status})`);

	// 인코딩 확인 및 원본 텍스트 확보 (제목 및 메타 정보용)
	const resClone = res.clone();
	const buffer = await res.arrayBuffer();
	let contentType = res.headers.get('content-type') || '';
	let decoder = new TextDecoder('utf-8');
	let htmlForMeta = decoder.decode(buffer);
	
	if (htmlForMeta.includes('charset="euc-kr"') || htmlForMeta.includes('charset="ks_c_5601-1987"') || contentType.includes('euc-kr') || htmlForMeta.includes('charset="cp949"')) {
		decoder = new TextDecoder('euc-kr');
		htmlForMeta = decoder.decode(buffer);
	}

	// 제목 추출
	let title = "";
	const titleMatch = htmlForMeta.match(/<title>(.*?)<\/title>/i);
	if (titleMatch) title = titleMatch[1].split(/[|:-]/)[0].trim();

	// HTMLRewriter를 이용한 강력한 본문 추출
	let bodyText = "";
	const rewriter = new HTMLRewriter()
		// 주요 본문 컨테이너들 지정
		.on('#article-view-content-div, #articleBody, #newsContext, #news_body_id, .article_view, .article_body, .view_con, #article_content, #articletxt, article', {
			text(text) {
				bodyText += text.text;
			}
		});

	// 리라이터를 실행하여 본문 텍스트 수집 (스트리밍 방식이라 매우 빠르고 정확함)
	await rewriter.transform(resClone).arrayBuffer();

	// 만약 위 방식으로 추출된 내용이 너무 적으면 (컨테이너 매칭 실패) 전체 body에서 추출
	if (bodyText.length < 300) {
		bodyText = "";
		const fallbackRewriter = new HTMLRewriter()
			.on('body', { text(t) { bodyText += t.text; } });
		await rewriter.transform(new Response(buffer)).arrayBuffer(); // buffer 재사용
	}

	// 텍스트 정제 (불완전한 공백 및 노이즈 제거)
	let content = bodyText
		.replace(/\t/g, ' ')
		.replace(/[\r\n]+/g, '\n\n') // 개행을 명확하게 분리
		.replace(/\s{2,}/g, ' ')     // 과도한 공백 정리
		.replace(/([^\n])\n\n([^\n])/g, '$1\n$2') // 너무 벌어진 문단은 살짝 조절
		.trim();

	// 기사 본문이라고 보기 힘든 앞뒤 노이즈 제거 (간단하게)
	if (content.length > 5000) content = content.substring(0, 5000);

	if (content.length < 100) {
		// 최후의 수단: 정규식 기반 전체 텍스트 추출
		content = htmlForMeta.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
							 .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
							 .replace(/<[^>]+>/g, ' ')
							 .replace(/\s+/g, ' ')
							 .trim();
	}

	return {
		title: title || "제목 없음",
		content: content,
		publisher: new URL(url).hostname,
	};
}

async function generateWithGemini(title, content, apiKey) {
	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
	
	// 본문이 너무 없으면 제목만으로 시도
	const prompt = `뉴스 기사 제목: ${title}\n뉴스 본문: ${content.substring(0, 3000)}\n\n위 뉴스를 인스타그램 카드뉴스 형태로 요약해줘. 형식: { "title": "강렬한 제목", "summary": "3줄 요약" } (JSON으로 응답)`;
	
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: jsonBody(prompt)
	});
	
	const data = await res.json();
	if (!data.candidates || data.candidates.length === 0) {
		console.error("Gemini Error:", JSON.stringify(data));
		return { title: "요약 실패", summary: "AI가 내용을 분석할 수 없습니다." };
	}
	const text = data.candidates[0].content.parts[0].text;
	try {
		return JSON.parse(text.replace(/```json|```/g, ""));
	} catch (e) {
		return { title: title, summary: text.substring(0, 200) };
	}
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
