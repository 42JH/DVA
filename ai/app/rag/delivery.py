"""Live의 append 한도를 지키면서 자료의 모든 문자를 보존한다."""

from functools import lru_cache
import tiktoken


@lru_cache(maxsize=1)
def encoders():
    return [tiktoken.get_encoding(name) for name in ('o200k_base', 'cl100k_base')]


def split_context(text, limit):
    chunks = []
    while text:
        low, high = 1, len(text)
        while low <= high:
            middle = (low+high)//2
            if max(len(enc.encode(text[:middle], disallowed_special=())) for enc in encoders()) <= limit:
                low = middle+1
            else:
                high = middle-1
        if high < 1:
            raise ValueError('한 문자를 담을 토큰 여유가 없습니다.')
        chunks.append(text[:high])
        text = text[high:]
    return chunks
