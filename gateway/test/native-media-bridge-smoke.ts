import assert from 'node:assert/strict';
import { DifyConverterService } from '../src/converter/dify-converter.service';
import {
  MEDIA_RUN_TOKEN_INPUT,
  collectNativeMediaCredentialIds,
  mediaIdempotencyInputName,
} from '../src/converter/native-media-bridge';
import { FlowGramJSON } from '../src/converter/types';

const CREDENTIAL_ID = '11111111-1111-4111-8111-111111111111';

const outputProperties = {
  jobId: { type: 'string' },
  assetId: { type: 'string' },
  url: { type: 'string' },
  poster: { type: 'string' },
  caption: { type: 'string' },
  mediaType: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  taskId: { type: 'string' },
  status: { type: 'string' },
  mimeType: { type: 'string' },
  byteSize: { type: 'number' },
  sha256: { type: 'string' },
};

function imageFlow(): FlowGramJSON {
  return {
    nodes: [
      {
        id: 'start_media',
        type: 'start',
        data: {
          title: '开始',
          inputsValues: { prompt: { type: 'constant', content: '一只熊猫' } },
          outputs: {
            type: 'object',
            required: ['prompt'],
            properties: { prompt: { type: 'string', title: '生成提示词' } },
          },
        },
      },
      {
        id: 'image_native',
        type: 'image',
        data: {
          title: 'OpenAI 图片生成',
          media: {
            mode: 'generate',
            operation: 'generate',
            provider: 'openai',
            credentialId: CREDENTIAL_ID,
            model: 'gpt-image-1',
            size: '1024x1024',
          },
          inputsValues: {
            prompt: { type: 'ref', content: ['start_media', 'prompt'] },
            caption: { type: 'constant', content: '熊猫图片' },
          },
          outputs: { type: 'object', properties: outputProperties },
        },
      },
      {
        id: 'end_media',
        type: 'end',
        data: {
          title: '结束',
          inputsValues: {
            jobId: { type: 'ref', content: ['image_native', 'jobId'] },
            url: { type: 'ref', content: ['image_native', 'url'] },
            status: { type: 'ref', content: ['image_native', 'status'] },
          },
          inputs: {
            type: 'object',
            properties: {
              jobId: { type: 'string' },
              url: { type: 'string' },
              status: { type: 'string' },
            },
          },
          outputs: { type: 'object', properties: {} },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start_media', targetNodeID: 'image_native' },
      { sourceNodeID: 'image_native', targetNodeID: 'end_media' },
    ],
  };
}

function videoQueryFlow(): FlowGramJSON {
  const flow = imageFlow();
  flow.nodes = [
    flow.nodes[0],
    {
      id: 'video_query',
      type: 'video',
      data: {
        title: '查询视频任务',
        media: {
          mode: 'generate',
          operation: 'query',
          provider: 'minimax',
          credentialId: CREDENTIAL_ID,
          model: 'MiniMax-H3',
        },
        inputsValues: {
          taskId: { type: 'ref', content: ['start_media', 'prompt'] },
          caption: { type: 'constant', content: '' },
        },
        outputs: { type: 'object', properties: outputProperties },
      },
    },
    {
      ...flow.nodes[2],
      data: {
        ...flow.nodes[2].data,
        inputsValues: {
          jobId: { type: 'ref', content: ['video_query', 'jobId'] },
        },
        inputs: {
          type: 'object',
          properties: { jobId: { type: 'string' } },
        },
      },
    },
  ];
  flow.edges = [
    { sourceNodeID: 'start_media', targetNodeID: 'video_query' },
    { sourceNodeID: 'video_query', targetNodeID: 'end_media' },
  ];
  return flow;
}

function main() {
  const previousUrl = process.env.DIFY_MEDIA_GATEWAY_URL;
  process.env.DIFY_MEDIA_GATEWAY_URL = 'http://host.docker.internal:3201';
  try {
    const converter = new DifyConverterService();
    const source = imageFlow();
    const before = JSON.stringify(source);
    const dsl = converter.toDifyDSL(source);
    assert.equal(JSON.stringify(source), before, '转换不得修改已保存的语义画布');
    assert.deepEqual(collectNativeMediaCredentialIds(source), [CREDENTIAL_ID]);

    const graph = dsl.workflow.graph;
    assert.equal(graph.nodes.length, 4, '一个原生媒体节点应展开为 HTTP + 解析器');
    const start = graph.nodes.find((node) => node.id === 'start_media')!;
    const hiddenNames = start.data.variables.map((variable: any) => variable.variable);
    const idempotencyInputName = mediaIdempotencyInputName('image_native');
    assert.match(
      idempotencyInputName,
      /^[a-zA-Z_][a-zA-Z0-9_]{0,29}$/,
      'Dify 模板变量的单个属性段必须符合 0.15.x 的长度和命名限制',
    );
    assert.ok(
      idempotencyInputName.length <= 30,
      'Dify 模板变量的单个属性段不能超过 30 个字符',
    );
    assert(hiddenNames.includes(MEDIA_RUN_TOKEN_INPUT));
    assert(hiddenNames.includes(idempotencyInputName));

    const request = graph.nodes.find((node) => node.data.type === 'http-request')!;
    assert.equal(request.data.method, 'post');
    assert.equal(request.data.url, 'http://host.docker.internal:3201/media/images/generate');
    assert.equal(request.data.authorization.type, 'api-key');
    assert.equal(
      request.data.authorization.config.api_key,
      `{{#start_media.${MEDIA_RUN_TOKEN_INPUT}#}}`,
    );
    assert.match(request.data.headers, /Idempotency-Key:\s+\{\{#start_media\.__ffmi_[a-f0-9]{16}#\}\}/);
    assert.match(request.data.body.data[0].value, /"credentialId":"11111111-1111-4111-8111-111111111111"/);
    assert.match(request.data.body.data[0].value, /"prompt":"\{\{#start_media\.prompt#\}\}"/);
    assert.equal(request.data.retry_config.retry_enabled, false);

    const minimaxVideo = imageFlow();
    minimaxVideo.nodes[1].type = 'video';
    minimaxVideo.nodes[1].data.title = 'MiniMax H3 视频生成';
    minimaxVideo.nodes[1].data.media = {
      mode: 'generate',
      operation: 'create',
      provider: 'minimax',
      credentialId: CREDENTIAL_ID,
      model: 'MiniMax-H3',
      resolution: '2K',
      aspectRatio: '9:16',
      durationSeconds: 5,
    };
    const videoDsl = converter.toDifyDSL(minimaxVideo);
    const videoRequest = videoDsl.workflow.graph.nodes.find((node) => node.data.type === 'http-request')!;
    assert.equal(videoRequest.data.url, 'http://host.docker.internal:3201/media/videos/generate');
    assert.match(videoRequest.data.body.data[0].value, /"resolution":"2K"/);
    assert.match(videoRequest.data.body.data[0].value, /"aspectRatio":"9:16"/);
    assert.match(videoRequest.data.body.data[0].value, /"durationSeconds":5/);

    const automatic = imageFlow();
    automatic.nodes[1].data.media.size = 'auto';
    automatic.nodes[1].data.media.aspectRatio = 'auto';
    const automaticDsl = converter.toDifyDSL(automatic);
    const automaticRequest = automaticDsl.workflow.graph.nodes.find((node) => node.data.type === 'http-request')!;
    assert.doesNotMatch(automaticRequest.data.body.data[0].value, /"size"|"aspectRatio"/);

    const parser = graph.nodes.find((node) => node.id === 'image_native')!;
    assert.equal(parser.data.type, 'code');
    assert(
      parser.data.variables.some((item: any) => (
        Array.isArray(item.value_selector)
        && item.value_selector[0] === request.id
        && item.value_selector[1] === 'status_code'
      )),
      '媒体解析器必须接收 HTTP 状态码',
    );
    assert.match(parser.data.code, /媒体网关请求失败/);
    assert.match(parser.data.code, /媒体网关返回缺少有效任务状态/);
    assert.deepEqual(Object.keys(parser.data.outputs).sort(), Object.keys(outputProperties).sort());
    const yaml = converter.toDifyDSLYaml(source);
    assert.doesNotMatch(yaml, /sk-[A-Za-z0-9]/);
    assert.match(yaml, /__futureflow_media_token/);

    const queryDsl = converter.toDifyDSL(videoQueryFlow());
    const queryStart = queryDsl.workflow.graph.nodes.find((node) => node.id === 'start_media')!;
    const queryInputs = queryStart.data.variables.map((variable: any) => variable.variable);
    assert(queryInputs.includes(MEDIA_RUN_TOKEN_INPUT));
    assert(!queryInputs.includes(mediaIdempotencyInputName('video_query')));
    const query = queryDsl.workflow.graph.nodes.find((node) => node.data.type === 'http-request')!;
    assert.equal(query.data.method, 'get');
    assert.equal(
      query.data.url,
      'http://host.docker.internal:3201/media/jobs/{{#start_media.prompt#}}',
    );
    assert.equal(query.data.body.type, 'none');
    assert.equal(query.data.retry_config.retry_enabled, false);

    const invalid = imageFlow();
    invalid.nodes[1].data.media.credentialId = 'not-a-credential';
    assert.throws(() => converter.toDifyDSL(invalid), /请选择有效的服务凭据/);
    const missingPrompt = imageFlow();
    missingPrompt.nodes[1].data.inputsValues!.prompt = { type: 'constant', content: '' };
    assert.throws(() => converter.toDifyDSL(missingPrompt), /生成提示词.*不能为空/);

    console.log('原生媒体桥：图片创建、MiniMax 视频创建/查询、短期令牌引用、幂等键与凭据隔离契约通过');
  } finally {
    if (previousUrl === undefined) delete process.env.DIFY_MEDIA_GATEWAY_URL;
    else process.env.DIFY_MEDIA_GATEWAY_URL = previousUrl;
  }
}

main();
