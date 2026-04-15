-- CreateTable
CREATE TABLE "scrollback_chunks" (
    "id" UUID NOT NULL,
    "reconnect_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "session_name" TEXT NOT NULL,
    "seq_num" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scrollback_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scrollback_chunks_reconnect_id_idx" ON "scrollback_chunks"("reconnect_id");

-- CreateIndex
CREATE UNIQUE INDEX "scrollback_chunks_reconnect_id_seq_num_key" ON "scrollback_chunks"("reconnect_id", "seq_num");
