#!/usr/bin/env bash
# Deploy this agent to an existing AWS App Runner service backed by ECR.
#
# Builds a linux/amd64 image tagged with the git commit, pushes it to ECR,
# then points the App Runner service at that exact tag. The service's existing
# environment variables, port, roles and instance settings are kept; only the
# image (and any --set / --set-file variables) change.
#
# Why not ":latest" + start-deployment? A service pinned to a specific tag keeps
# redeploying that tag, so start-deployment silently ships the old build.
#
# Usage:
#   scripts/deploy-apprunner.sh                      # build, push, deploy HEAD
#   scripts/deploy-apprunner.sh --dry-run            # show what would change, touch nothing
#   scripts/deploy-apprunner.sh --image-tag <tag>    # redeploy/roll back to an existing tag (no build)
#   scripts/deploy-apprunner.sh --image-tag <current tag> --set AGENT_NAME="Linq Sullivan" \
#                               --set-file AGENT_PERSONA=~/linq-sullivan-persona.md
#                                                    # config-only change (no build)
#   scripts/deploy-apprunner.sh --unset SOME_VAR     # remove an env var (combine with --image-tag)
#
# Without --image-tag the script builds and ships the checked-out commit, so it
# only builds from main (in sync with origin/main) unless you pass --allow-branch.
#
# Settings (env vars):
#   APPRUNNER_SERVICE  App Runner service name (required)
#   ECR_REPOSITORY     ECR repository name     (default: same as service name)
#   AWS_REGION         region                  (default: us-east-1)
#   AWS_PROFILE        standard AWS CLI profile selection, if you use one
#   EXPECTED_AWS_ACCOUNT  if set, refuse to run against any other account
#
# Needs: aws CLI v2 with credentials, docker with buildx (Docker Desktop running), python3, git.
set -euo pipefail

SERVICE="${APPRUNNER_SERVICE:-}"
REPO="${ECR_REPOSITORY:-$SERVICE}"
REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=0
SKIP_TESTS=0
ALLOW_DIRTY=0
ALLOW_BRANCH=0
IMAGE_TAG=""
SETS=()      # KEY=VALUE
SET_FILES=() # KEY=PATH
UNSETS=()    # KEY

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-branch) ALLOW_BRANCH=1 ;;
    --image-tag) IMAGE_TAG="${2:?--image-tag needs a value}"; shift ;;
    --set) [[ "${2:-}" == *=* ]] || die "--set needs KEY=VALUE"; SETS+=("$2"); shift ;;
    --set-file) [[ "${2:-}" == *=* ]] || die "--set-file needs KEY=PATH"; SET_FILES+=("$2"); shift ;;
    --unset) UNSETS+=("${2:?--unset needs a KEY}"); shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[[ -n "$SERVICE" ]] || die "set APPRUNNER_SERVICE to your App Runner service name"

cd "$(git rev-parse --show-toplevel)"

for f in "${SET_FILES[@]+"${SET_FILES[@]}"}"; do
  [[ -f "${f#*=}" ]] || die "--set-file: ${f#*=} not found"
  [[ -n "$(tr -d '[:space:]' < "${f#*=}")" ]] || die "--set-file: ${f#*=} is empty"
done
for kv in "${SETS[@]+"${SETS[@]}"}"; do
  [[ -n "${kv#*=}" ]] || die "--set ${kv%%=*}= has an empty value; use --unset ${kv%%=*} to remove it"
done

# --- AWS identity and target service -----------------------------------------
IDENTITY=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) \
  || die "AWS CLI has no working credentials. Run 'aws configure' (or 'aws sso login') first."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
log "AWS identity: $IDENTITY"
if [[ -n "${EXPECTED_AWS_ACCOUNT:-}" && "$ACCOUNT" != "$EXPECTED_AWS_ACCOUNT" ]]; then
  die "AWS account is $ACCOUNT, expected $EXPECTED_AWS_ACCOUNT (check AWS_PROFILE)"
fi

SERVICE_ARN=$(aws apprunner list-services --region "$REGION" \
  --query "ServiceSummaryList[?ServiceName=='$SERVICE'].ServiceArn | [0]" --output text)
[[ -n "$SERVICE_ARN" && "$SERVICE_ARN" != "None" ]] || die "App Runner service '$SERVICE' not found in $REGION"
log "Service: $SERVICE_ARN"

STATUS=$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query Service.Status --output text)
[[ "$STATUS" == "RUNNING" ]] || die "service status is $STATUS; wait for it to be RUNNING (an operation may be in progress)"

REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
CURRENT_IMAGE=$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" \
  --query Service.SourceConfiguration.ImageRepository.ImageIdentifier --output text)
log "Currently running: $CURRENT_IMAGE"

# --- Decide the image tag ----------------------------------------------------
BUILD=1
if [[ -n "$IMAGE_TAG" ]]; then
  BUILD=0
  aws ecr describe-images --region "$REGION" --repository-name "$REPO" --image-ids imageTag="$IMAGE_TAG" >/dev/null 2>&1 \
    || die "tag '$IMAGE_TAG' not found in ECR repo $REPO"
else
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [[ $ALLOW_BRANCH -eq 0 ]]; then
    [[ "$BRANCH" == "main" ]] || die "on branch '$BRANCH'. Deploy from main, pass --allow-branch to ship this branch, or use --image-tag <current tag> for a config-only change"
    git fetch -q origin main || die "could not fetch origin/main"
    [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
      || die "local main is not origin/main; run 'git pull --ff-only' (or pass --allow-branch)"
  fi
  if [[ $ALLOW_DIRTY -eq 0 ]]; then
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] \
      || die "working tree has uncommitted changes; commit them or pass --allow-dirty"
    # Untracked files here would be baked into the image (Dockerfile does COPY . .)
    UNTRACKED=$(git status --porcelain -- src test package.json package-lock.json tsconfig.json Dockerfile | grep '^??' || true)
    [[ -z "$UNTRACKED" ]] || die "untracked build inputs would end up in the image:
$UNTRACKED"
  fi
  SHA=$(git rev-parse --short HEAD)
  DIRTY=""; [[ -n "$(git status --porcelain --untracked-files=no)" ]] && DIRTY="-dirty"
  IMAGE_TAG="$(git rev-parse --abbrev-ref HEAD | tr '/' '-' | cut -c1-40)-$SHA$DIRTY-$(date -u +%Y%m%d-%H%M%S)"
fi
NEW_IMAGE="$REGISTRY/$REPO:$IMAGE_TAG"
log "Deploying: $NEW_IMAGE"

# --- Build the new SourceConfiguration (secrets never printed) ---------------
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" \
  --query Service.SourceConfiguration --output json > "$WORK/current.json"

SETS_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${SETS[@]+"${SETS[@]}"}")
FILES_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${SET_FILES[@]+"${SET_FILES[@]}"}")
UNSETS_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${UNSETS[@]+"${UNSETS[@]}"}")

python3 - "$WORK/current.json" "$WORK/new.json" "$NEW_IMAGE" "$SETS_JSON" "$FILES_JSON" "$UNSETS_JSON" <<'PY'
import json, sys
cur_path, new_path, image, sets, files, unsets = sys.argv[1:7]
cfg = json.load(open(cur_path))
ir = cfg["ImageRepository"]
ir["ImageIdentifier"] = image
ic = ir.setdefault("ImageConfiguration", {})
env = ic.setdefault("RuntimeEnvironmentVariables", {})
before = dict(env)
for kv in json.loads(sets):
    k, v = kv.split("=", 1); env[k] = v
for kp in json.loads(files):
    k, p = kp.split("=", 1); env[k] = open(p, encoding="utf-8").read().strip()
for k in json.loads(unsets):
    env.pop(k, None)
# AutoDeploymentsEnabled must stay as-is; never echo values.
json.dump(cfg, open(new_path, "w"))
added   = sorted(set(env) - set(before))
removed = sorted(set(before) - set(env))
changed = sorted(k for k in env if k in before and env[k] != before[k])
print("    env vars kept:    %d" % (len(env) - len(added) - len(changed)))
print("    env vars added:   %s" % (", ".join(added) or "none"))
print("    env vars changed: %s" % (", ".join(changed) or "none"))
print("    env vars removed: %s" % (", ".join(removed) or "none"))
for k in added + changed:
    print("      %s: %d chars" % (k, len(env[k])))
PY

if [[ $DRY_RUN -eq 1 ]]; then
  log "Dry run: nothing built, pushed or deployed."
  exit 0
fi

# --- Build and push ----------------------------------------------------------
if [[ $BUILD -eq 1 ]]; then
  docker info >/dev/null 2>&1 || die "Docker is not running (start Docker Desktop)"
  if [[ $SKIP_TESTS -eq 0 ]]; then
    log "Running npm test"
    npm test
  fi
  log "Logging in to ECR"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  log "Building linux/amd64 image and pushing"
  docker buildx build --platform linux/amd64 -t "$NEW_IMAGE" --push .
fi

# --- Point App Runner at the new image ---------------------------------------
log "Updating App Runner service"
OP_ID=$(aws apprunner update-service --region "$REGION" --service-arn "$SERVICE_ARN" \
  --source-configuration "file://$WORK/new.json" --query OperationId --output text)
log "Operation $OP_ID started; waiting (usually 3 to 6 minutes)"

TRIES=0
while true; do
  TRIES=$((TRIES + 1))
  if [[ $TRIES -gt 80 ]]; then
    die "still not finished after 20 minutes (operation $OP_ID). Check App Runner in the console before retrying."
  fi
  OP_STATUS=$(aws apprunner list-operations --region "$REGION" --service-arn "$SERVICE_ARN" \
    --query "OperationSummaryList[?Id=='$OP_ID'].Status | [0]" --output text 2>/dev/null || echo UNKNOWN)
  case "$OP_STATUS" in
    SUCCEEDED) break ;;
    FAILED|ROLLBACK_SUCCEEDED|ROLLBACK_FAILED|ROLLBACK_IN_PROGRESS)
      die "deployment $OP_STATUS. App Runner keeps the previous version running. Check the service log:
  aws logs tail /aws/apprunner/$SERVICE/${SERVICE_ARN##*/}/service --region $REGION --since 30m" ;;
    *) printf '.'; sleep 15 ;;
  esac
done
echo

URL=$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query Service.ServiceUrl --output text)
log "Deployed $IMAGE_TAG"
curl -fsS "https://$URL/health" && echo || echo "warning: /health did not answer"
echo "Previous image (for rollback): ${CURRENT_IMAGE##*:}"
echo "  scripts/deploy-apprunner.sh --image-tag ${CURRENT_IMAGE##*:}"
echo "Logs: aws logs tail /aws/apprunner/$SERVICE/${SERVICE_ARN##*/}/application --region $REGION --follow"
