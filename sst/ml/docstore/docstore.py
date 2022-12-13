"""
Utils for marshalling in / out of pandas
"""
import os
from typing import List, Dict, Optional
from common.env import VECTORS_PATH
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.feather as feather
from uuid import uuid4
from docstore.nodes import nodes
import torch
import logging
retriever = nodes.dense_retriever(batch_size=8)
from sentence_transformers.util import semantic_search


def to_tensor(nparr):
    # revisit: when getting directly, ValueError: setting an array element with a sequence.
    return torch.tensor(nparr.tolist(), device="cpu")

# TODO
# currently loading bookstore & Q/A in master search lambda. These two tasks
# should be separated to Lambdas, so it's (1) search/add-entry; (2) QA; (3) books
class BookStore(object):
    def __init__(self):
        self.df = None
        self.dir = f"{VECTORS_PATH}/books/embeddings.feather"
        self.file = f"{self.dir}/embeddings.feather"

    def load(self):
        # TODO have s3->efs pipeline so I can upload/update
        if not os.path.exists(self.file):
            os.makedirs(self.dir, exist_ok=True)
            s3_path = 'vectors/books/embeddings.feather'
            logging.warning("{} doesn't exist. Downloading from {}/{}".format(
                self.file,
                os.getenv("bucket_name"),
                s3_path
            ))
            import boto3
            s3 = boto3.client('s3')
            s3.download_file(
                os.getenv("bucket_name"),
                s3_path,
                self.dir
            )
        self.df = feather.read_feather(self.file)

    def search(self, search_emb):
        if self.df is None:
            self.load()
        results = semantic_search(
            query_embeddings=search_emb,
            corpus_embeddings=to_tensor(self.df.embedding),
            top_k=50,
            corpus_chunk_size=100
        )
        idx_order = [r['corpus_id'] for r in results[0]]
        ordered = self.df.iloc[idx_order].drop(columns=['embedding'])
        return ordered.to_dict("records")

class EntryStore(object):
    def __init__(self, user_id):
        self.user_id = user_id
        self.entry = None
        self.dfs = []

        # We'll be storing vectors on EFS
        # TODO check against vectors_version (as we update schema)
        self.dir = f"{VECTORS_PATH}/{user_id}"
        os.makedirs(self.dir, exist_ok=True)
        self.file = f"{self.dir}/entries.parquet"

    def embed(self, texts: List[str]):
        # manually encode here because WeaviateDocumentStore will write document with np.rand,
        # then you re-fetch the document and update_embeddings()
        return retriever.embedding_encoder.embed(texts)

    def load(self, filters: List):
        if not os.path.exists(self.file):
            logging.warning(f"{self.file} doesn't exist")
            return pd.DataFrame([])
        return pq.read_table(self.file, filters=filters).to_pandas()

    def add_entry(self, entry: Dict, paras: List[str]):
        self.entry = entry
        print("Embedding paras")
        paras_embeddings = self.embed(paras)
        paras = pd.DataFrame([
            dict(
                id=str(uuid4()),  # wouldn't be unique. We'll filter via orig_id
                obj_id=entry['id'],
                obj_type='paragraph',
                content=p,
                created_at=entry['created_at'],  # used for sorting in analyze later
                embedding=paras_embeddings[i]
            ) for i, p in enumerate(paras)
        ])
        self.dfs.append(paras)

        entry_mean = np.mean(paras_embeddings, axis=0)
        entry = pd.DataFrame([
            dict(
                id=entry['id'],
                obj_id=entry['id'],
                obj_type='entry',
                content=entry['summary'],  # will use for future summarizing many summaries
                created_at=entry['created_at'],
                embedding=entry_mean
            )
        ])
        self.dfs.append(entry)

    def save(self):
        entry = self.entry
        if os.path.exists(self.file):
            # TODO file-lock
            # remove original paras, entry, and user-mean; this is an upsert
            df = self.load([("obj_id", "not in", {entry['id'], self.user_id})])
            self.dfs.append(df)
            # TODO handle bio, people
        new_df = pd.concat(self.dfs)
        user_mean = new_df[new_df.obj_type == "paragraph"].embedding.mean(axis=0)
        new_df = pd.concat([
            new_df,
            pd.DataFrame([dict(
                id=self.user_id,
                obj_id=self.user_id,
                obj_type='user',
                content="",
                created_at=entry['created_at'],  # inaccurate, but we're not using this anywhere
                embedding=user_mean
            )]
            )])
        pq.write_table(
            pa.Table.from_pandas(new_df),
            self.file,
        )
        # TODO file-unlock

    def entries_to_haystack(self, entries):
        from haystack import Document
        return [
            Document(
                id=d['id'],
                content=d['content'],
                meta={
                    'obj_id': d['obj_id'],
                    'obj_type': d['obj_type'],
                    'created_at': d['created_at']
                },
                embedding=d['embedding']
            )
            for d in entries
        ]