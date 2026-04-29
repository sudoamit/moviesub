from sqlalchemy import Column, String, ForeignKey, Integer, Float, DateTime, JSON, Index, text
from sqlalchemy.dialects.postgresql import UUID, VECTOR
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False)
    api_key_hash = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=text('NOW()'))

class Repository(Base):
    __tablename__ = "repositories"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey('users.id'))
    name = Column(String, nullable=False)
    remote_url = Column(String)
    last_indexed = Column(DateTime(timezone=True))

class Symbol(Base):
    __tablename__ = "symbols"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), ForeignKey('repositories.id'))
    name = Column(String, nullable=False)
    kind = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    location_range = Column(JSON, nullable=False)
    signature = Column(String)

# Add other models similarly...
# ChatSession, ChatMessage, CodeEmbedding, etc.
