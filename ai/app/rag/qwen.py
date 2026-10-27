"""평가에 사용한 Qwen 원문 Q+A 리랭커. GPU 서비스만 import한다."""

MODEL = 'Qwen/Qwen3-Reranker-0.6B'


INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query'


PREFIX = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'


SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'


def format_pair(query, document, instruction=INSTRUCTION):
    return f'<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}'


def tokenize_pairs(tokenizer, pairs, max_length, instruction=INSTRUCTION):
    prefix = tokenizer.encode(PREFIX, add_special_tokens=False)
    suffix = tokenizer.encode(SUFFIX, add_special_tokens=False)
    budget = max_length-len(prefix)-len(suffix)
    if budget < 1:
        raise ValueError('모델 입력 길이가 지시문보다 짧습니다.')
    encoded = tokenizer([format_pair(query, doc, instruction) for query, doc in pairs], padding=False,
                        truncation=False, return_attention_mask=False)
    lengths = [len(ids)+len(prefix)+len(suffix) for ids in encoded['input_ids']]
    if any(length > max_length for length in lengths):
        raise ValueError('입력이 최대 길이를 넘습니다. 자동으로 답변을 자르지 않습니다.')
    tokens = {'input_ids': [prefix+ids+suffix for ids in encoded['input_ids']]}
    return tokenizer.pad(tokens, padding=True, return_tensors='pt'), lengths


class QwenReranker:
    def __init__(self, snapshot, dtype, max_length, instruction=INSTRUCTION):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.torch = torch
        self.max_length = max_length
        self.instruction = instruction
        self.tokenizer = AutoTokenizer.from_pretrained(snapshot, padding_side='left', local_files_only=True, trust_remote_code=False)
        self.model = AutoModelForCausalLM.from_pretrained(snapshot, local_files_only=True,
            trust_remote_code=False, torch_dtype=getattr(torch, dtype), attn_implementation='sdpa').to('cuda').eval()
        self.no_id = self.tokenizer.convert_tokens_to_ids('no')
        self.yes_id = self.tokenizer.convert_tokens_to_ids('yes')
        if self.tokenizer.encode('no', add_special_tokens=False) != [self.no_id] or self.tokenizer.encode('yes', add_special_tokens=False) != [self.yes_id] or self.no_id == self.yes_id:
            raise ValueError('공식 yes/no 토큰 대응을 확인하세요.')

    def predict(self, pairs):
        inputs, _ = tokenize_pairs(self.tokenizer, pairs, self.max_length, self.instruction)
        inputs = {key: value.to('cuda') for key, value in inputs.items()}
        with self.torch.inference_mode():
            # 설치된 Qwen3 공식 forward의 마지막 위치 계산 옵션으로 메모리를 절약한다.
            logits = self.model(**inputs, use_cache=False, logits_to_keep=1).logits[:, -1, :]
            scores = logits[:, self.yes_id].float()-logits[:, self.no_id].float()
        # 공식 yes/no softmax와 단조 대응하는 logit 차이로 순위를 매긴다.
        return scores.cpu().tolist()


REVISION = 'e61197ed45024b0ed8a2d74b80b4d909f1255473'
