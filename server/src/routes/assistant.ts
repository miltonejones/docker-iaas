import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { getAuthUser } from "../auth.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { docker } from "../docker.js";
import { stripLogHeaders } from "./containers.js";
import {
  listContainerFiles,
  probeContainerEndpoint,
} from "./containers.js";
import {
  listFunctions,
  getFunction,
  listRoutes,
  listAssistantSessions,
  getAssistantSession,
  createAssistantSession,
  updateAssistantSession,
  deleteAssistantSession,
  listAssistantIssues,
  getAssistantIssue,
  createAssistantIssue,
  updateAssistantIssue,
  deleteAssistantIssue,
  clearAssistantIssues,
  ASSISTANT_ISSUE_STATUSES,
} from "../db.js";
import { sessionRegistry } from "../sessionRunner.js";
import { getS3Client } from "../minio.js";
import { PRESETS } from "../presets.js";
import { listHostBuildPresets } from "./hostBuilds.js";
import { listHostDirectory, readHostTextFile } from "./hostFiles.js";
import {
  DATABASE_ASSISTANT_READ_ONLY_TOOLS,
  DATABASE_ASSISTANT_TOOLS,
  executeDatabaseAssistantReadOnlyTool,
} from "../databaseAssistantTools.js";
import {
  GITHUB_ASSISTANT_READ_ONLY_TOOLS,
  GITHUB_ASSISTANT_TOOLS,
  executeGithubAssistantReadOnlyTool,
} from "../githubAssistantTools.js";