from langchain_openai import OpenAIEmbeddings


MODEL_DIMENSIONS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
}


def create_embeddings(*, model: str = "text-embedding-3-small") -> OpenAIEmbeddings:
    """비교 모델을 지정한다. 생략하면 기존 small을 유지한다."""
    if model not in MODEL_DIMENSIONS:
        raise ValueError("지원하지 않는 임베딩 모델입니다.")
    return OpenAIEmbeddings(model=model)
