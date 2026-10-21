# Code for how to check similarity between a reference sentence and test sentences -> Used in checking retrieval quality

# pip install sentence-transformers pandas numpy

import numpy as np
import pandas as pd
from sentence_transformers import CrossEncoder

# 1. Initialize the Cross-Encoder model
model_name = "cross-encoder/ms-marco-MiniLM-L-6-v2"
model = CrossEncoder(model_name)

# 2. Define the query and retrieved context pairs to evaluate
query = "What is the capital of France?"
retrieved_contexts = [
    "Paris is the capital and most populous city of France.",
    "The Eiffel Tower is a famous landmark located in Paris, France.",
    "Berlin is the capital of Germany and its largest city by both area and population.",
]

# 3. Format as a list of pairs: [[query, context_1], [query, context_2], ...]
pairs = [[query, doc] for doc in retrieved_contexts]

# 4. Predict similarity scores (raw logits)
raw_scores = model.predict(pairs)

# 5. Map logits to a 0-1 probability scale using Sigmoid, then convert to percentage
sigmoid_scores = 1 / (1 + np.exp(-raw_scores))
percentage_scores = sigmoid_scores * 100

# 6. Build and format results DataFrame
results = pd.DataFrame(
    {
        "Query": [query] * len(retrieved_contexts),
        "Retrieved Context": retrieved_contexts,
        "Raw Score": raw_scores,
        "Similarity (%)": [f"{score:.2f}%" for score in percentage_scores],
    }
).sort_values(by="Raw Score", ascending=False)

# 7. Print the results table
print(results.to_string(index=False))
