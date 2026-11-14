"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import {
  markdownPreviewRemarkPlugins,
  normalizeDisplayMath,
} from "@/lib/markdown";
import { getPromptPreview, type ChatTurn } from "@/lib/chat-turns";
import { loadMinimapPreviewLocked, saveMinimapPreviewLocked } from "@/lib/minimap-preview-lock";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ChatMinimap.module.css";

interface Props {
  /** The transcript's turns, in order. */
  turns: ChatTurn[];
  /** The transcript's scroll container. */
  scrollContainer: HTMLDivElement | null;
  /** The DOM node of each turn's prompt, indexed like `turns`. */
  turnRefs: RefObject<(HTMLDivElement | null)[]>;
  /** The DOM node of each turn's answer, indexed like `turns`. */
  answerRefs: RefObject<(HTMLDivElement | null)[]>;
  /** Reveals the transcript rows that are folded away, so a turn the
   *  transcript has not rendered yet can be scrolled to. */
  onRevealHistory: () => void;
}

const MINIMAP_WIDTH = 36;
const MAX_NODE_GAP = 50;
const MINIMAP_PADDING = 12;
// The lock button sits at the bottom of the rail (6px inset + 30px): nodes stop
// above it so the last turn stays visible and clickable.
const MINIMAP_BOTTOM_PADDING = 36 + MINIMAP_PADDING;
const PREVIEW_HIDE_DELAY = 250;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

interface TurnNode {
  topRatio: number;
  index: number;
  /** The turn's offset in the scroll container, once measured. */
  scrollTop: number | null;
}

interface NodeLayout {
  nodes: TurnNode[];
  gap: number;
  fillsHeight: boolean;
}

function PreviewHeading({
  level,
  children,
  headingIndex,
  onClick,
}: {
  level: 1 | 2 | 3;
  children: React.ReactNode;
  headingIndex: number | null;
  onClick?: (headingIndex: number) => void;
}) {
  return (
    <button
      type="button"
      className={styles.heading}
      data-level={level}
      data-preview-heading-index={headingIndex ?? undefined}
      disabled={headingIndex === null || !onClick}
      onClick={(event) => {
        event.stopPropagation();
        if (headingIndex !== null) onClick?.(headingIndex);
      }}
    >
      {children}
    </button>
  );
}

interface PreviewAstNode {
  type?: string;
  depth?: number;
  data?: {
    hProperties?: Record<string, unknown>;
  };
}

/** Keeps only the headings (or the first paragraph) of an answer, so the
 *  preview lists the answer's structure instead of repeating the whole reply. */
function remarkPreviewOutline() {
  return (tree: { children?: PreviewAstNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    const headings = tree.children.filter((node) => (
      node.type === "heading" && typeof node.depth === "number" && node.depth <= 3
    ));
    if (headings.length > 0) {
      headings.forEach((node, headingIndex) => {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            "data-preview-heading-index": headingIndex,
          },
        };
      });
      tree.children = headings;
      return;
    }
    const firstParagraph = tree.children.find((node) => node.type === "paragraph");
    tree.children = firstParagraph ? [firstParagraph] : [];
  };
}

const previewRemarkPlugins = [
  ...(markdownPreviewRemarkPlugins ?? []),
  remarkPreviewOutline,
];
const previewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];

function getPreviewHeadingIndex(node: unknown): number | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataPreviewHeadingIndex ?? properties?.["data-preview-heading-index"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export const AssistantOutline = memo(function AssistantOutline({
  markdown,
  onHeadingClick,
  onAnswerClick,
}: {
  markdown: string;
  onHeadingClick?: (headingIndex: number) => void;
  onAnswerClick?: () => void;
}) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  if (!markdown) return null;
  return (
    <div className={styles.outline}>
      <ReactMarkdown
        remarkPlugins={previewRemarkPlugins}
        rehypePlugins={previewRehypePlugins}
        components={{
          h1: ({ children, node }) => <PreviewHeading level={1} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h2: ({ children, node }) => <PreviewHeading level={2} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h3: ({ children, node }) => <PreviewHeading level={3} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h4: () => null,
          h5: () => null,
          h6: () => null,
          p: ({ children }) => (
            <button
              type="button"
              className={styles.paragraph}
              onClick={onAnswerClick}
            >
              {children}
            </button>
          ),
          blockquote: () => null,
          ul: () => null,
          ol: () => null,
          pre: () => null,
          table: () => null,
          hr: () => null,
          a: ({ children }) => <>{children}</>,
          code: ({ children }) => <>{children}</>,
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

function layoutNodes(allNodes: TurnNode[], minimapHeight: number): NodeLayout {
  if (allNodes.length === 0) {
    return { nodes: [], gap: MAX_NODE_GAP, fillsHeight: false };
  }

  const height = Math.max(1, minimapHeight);
  const usableHeight = Math.max(0, height - MINIMAP_PADDING - MINIMAP_BOTTOM_PADDING);
  if (allNodes.length === 1) {
    return {
      nodes: [{ ...allNodes[0], topRatio: MINIMAP_PADDING / height }],
      gap: MAX_NODE_GAP,
      fillsHeight: false,
    };
  }

  const naturalGap = usableHeight / (allNodes.length - 1);
  const gap = Math.min(MAX_NODE_GAP, naturalGap);
  return {
    nodes: allNodes.map((node, index) => ({
      ...node,
      topRatio: (MINIMAP_PADDING + index * gap) / height,
    })),
    gap,
    fillsHeight: naturalGap <= MAX_NODE_GAP,
  };
}

/** The offset of a heading inside an answer, in scroll coordinates. The
 *  answer's markdown is rendered by the transcript, so the heading is found
 *  through the answer's own DOM node. */
function headingTopOf(
  answerElement: HTMLDivElement | null,
  headingIndex: number | undefined,
  scrollEl: HTMLDivElement,
  containerRect: DOMRect,
): number | null {
  if (headingIndex === undefined) return null;
  if (!answerElement) return null;
  const heading = answerElement
    .querySelectorAll<HTMLElement>("h1, h2, h3")
    .item(headingIndex);
  if (!heading) return null;
  const headingRect = heading.getBoundingClientRect();
  return headingRect.top - containerRect.top + scrollEl.scrollTop;
}

export const ChatMinimap = memo(function ChatMinimap({
  turns,
  scrollContainer,
  turnRefs,
  answerRefs,
  onRevealHistory,
}: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [allNodes, setAllNodes] = useState<TurnNode[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [minimapHeight, setMinimapHeight] = useState(600);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [locked, setLocked] = useState(loadMinimapPreviewLocked);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const allNodesRef = useRef<TurnNode[]>([]);
  const nodeLayoutRef = useRef<NodeLayout>({
    nodes: [],
    gap: MAX_NODE_GAP,
    fillsHeight: false,
  });
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const pendingNavigationRef = useRef<{
    nodeIndex: number;
    target: "prompt" | "answer" | "heading";
    headingIndex?: number;
  } | null>(null);
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const nodeLayout = useMemo(
    () => layoutNodes(allNodes, minimapHeight),
    [allNodes, minimapHeight],
  );
  const { nodes: positionedNodes, gap: nodeGap } = nodeLayout;
  nodeLayoutRef.current = nodeLayout;

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS,
    };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: TurnNode[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;

    const measuredNodes = nextNodes.filter((node) => node.scrollTop !== null);
    if (measuredNodes.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const nextActiveNode = measuredNodes.reduce((bestNode, node) => (
      Math.abs((node.scrollTop ?? 0) - focusTop)
        < Math.abs((bestNode.scrollTop ?? 0) - focusTop)
        ? node
        : bestNode
    ), measuredNodes[0]);
    setActiveIndex(nextActiveNode.index);
  }, []);

  /**
   * Measures where every turn sits in the transcript. The turn's prompt node
   * is the anchor: the answer's node only serves to find a heading inside it.
   */
  const measureNodes = useCallback((
    scrollEl: HTMLDivElement,
    minimapEl: HTMLDivElement,
    turnEls: (HTMLDivElement | null)[],
    answerEls: (HTMLDivElement | null)[],
  ) => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const containerRect = scrollEl.getBoundingClientRect();
      const currentTurns = turnsRef.current;

      const nextNodes: TurnNode[] = currentTurns.map((turn, index) => {
        const element = turnEls[index] ?? null;
        const rect = element?.getBoundingClientRect();
        return {
          index,
          topRatio: 0,
          scrollTop: rect ? rect.top - containerRect.top + scrollEl.scrollTop : null,
        };
      });

      setMinimapHeight(minimapEl.clientHeight);
      allNodesRef.current = nextNodes;
      setAllNodes(nextNodes);
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
      syncActiveNode(scrollEl, nextNodes);

      // A click on a turn the transcript has not rendered yet waits for the
      // layout instead of jumping.
      const pendingNavigation = pendingNavigationRef.current;
      const pendingNode = pendingNavigation ? nextNodes[pendingNavigation.nodeIndex] : null;
      if (!pendingNavigation || !pendingNode) return;
      const targetTop = pendingNavigation.target === "heading"
        ? headingTopOf(answerEls[pendingNavigation.nodeIndex] ?? null, pendingNavigation.headingIndex, scrollEl, containerRect)
        : pendingNode.scrollTop;
      if (targetTop === null) return;
      pendingNavigationRef.current = null;
      lockActiveNode(pendingNode.index);
      const targetOffset = scrollEl.clientHeight * 0.3;
      scrollEl.scrollTo({ top: Math.max(0, targetTop - targetOffset), behavior: "smooth" });
    }, 150);
  }, [lockActiveNode, syncActiveNode]);

  // The effects below read the transcript's DOM, which changes without the
  // minimap re-rendering. They call through refs so the effects themselves
  // stay stable.
  const measureRef = useRef(measureNodes);
  measureRef.current = measureNodes;
  const syncActiveNodeRef = useRef(syncActiveNode);
  syncActiveNodeRef.current = syncActiveNode;

  const updateScroll = useCallback((scrollEl: HTMLDivElement) => {
    setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
    syncActiveNodeRef.current(scrollEl, allNodesRef.current);
  }, []);

  const updateScrollRef = useRef(updateScroll);
  updateScrollRef.current = updateScroll;

  useEffect(() => {
    if (!scrollContainer) return;
    const onScroll = () => updateScrollRef.current(scrollContainer);
    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, [scrollContainer]);

  // The rail renders nothing until it knows the transcript scrolls, so it
  // measures itself once it is on the page. Without this the first
  // measurement would find no rail and the dots would never appear.
  useEffect(() => {
    if (!visible) return;
    const minimapEl = containerRef.current;
    if (!scrollContainer || !minimapEl) return;
    measureRef.current(scrollContainer, minimapEl, turnRefs.current, answerRefs.current);
    updateScrollRef.current(scrollContainer);
  }, [answerRefs, scrollContainer, turnRefs, turns.length, visible]);

  useEffect(() => {
    if (!scrollContainer) return;
    const syncLayout = () => {
      const minimapEl = containerRef.current;
      if (!minimapEl) return;
      measureRef.current(scrollContainer, minimapEl, turnRefs.current, answerRefs.current);
      updateScrollRef.current(scrollContainer);
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(scrollContainer);
    if (scrollContainer.firstElementChild) ro.observe(scrollContainer.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [answerRefs, scrollContainer, turnRefs]);

  const scrollToTurn = useCallback((node: TurnNode, behavior: ScrollBehavior) => {
    if (!scrollContainer) return;
    lockActiveNode(node.index);
    if (node.scrollTop === null) {
      pendingNavigationRef.current = { nodeIndex: node.index, target: "prompt" };
      onRevealHistory();
      return;
    }
    const targetTop = Math.max(
      0,
      node.scrollTop - scrollContainer.clientHeight * 0.3,
    );
    scrollContainer.scrollTo({ top: targetTop, behavior });
  }, [lockActiveNode, onRevealHistory, scrollContainer]);

  const locateHeading = useCallback((node: TurnNode, headingIndex: number) => {
    if (!scrollContainer) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetTop = headingTopOf(answerRefs.current[node.index] ?? null, headingIndex, scrollContainer, containerRect);
    if (targetTop === null) {
      pendingNavigationRef.current = { nodeIndex: node.index, target: "heading", headingIndex };
      onRevealHistory();
      return;
    }
    lockActiveNode(node.index);
    scrollContainer.scrollTo({
      top: Math.max(0, targetTop - scrollContainer.clientHeight * 0.3),
      behavior: "smooth",
    });
  }, [answerRefs, lockActiveNode, onRevealHistory, scrollContainer]);

  const findNearestNode = useCallback((ratio: number): TurnNode | null => {
    const { nodes, gap, fillsHeight } = nodeLayoutRef.current;
    const height = containerRef.current?.clientHeight ?? 0;
    if (nodes.length === 0 || height <= 0) return null;

    const pointerY = Math.max(0, Math.min(height, ratio * height));
    const firstNodeY = nodes[0].topRatio * height;
    const rawIndex = gap > 0 ? Math.round((pointerY - firstNodeY) / gap) : 0;
    const nodeIndex = Math.max(0, Math.min(nodes.length - 1, rawIndex));
    const nearestNode = nodes[nodeIndex];

    if (!fillsHeight) {
      const nodeY = nearestNode.topRatio * height;
      const hitRadius = Math.max(10, gap / 2);
      if (Math.abs(pointerY - nodeY) > hitRadius) return null;
    }
    return nearestNode;
  }, []);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const showPreview = useCallback(() => {
    if (locked) return;
    cancelPreviewHide();
    setMinimapHovered(true);
  }, [cancelPreviewHide, locked]);

  const toggleLock = useCallback(() => {
    const next = !locked;
    setLocked(next);
    saveMinimapPreviewLocked(next);
    if (next) {
      cancelPreviewHide();
      setMinimapHovered(false);
      setMouseYRatio(null);
    }
  }, [cancelPreviewHide, locked]);

  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      setMinimapHovered(false);
      setMouseYRatio(null);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    showPreview();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setMouseYRatio(pointerRatio);
    const jumpToPointer = (clientY: number, behavior: ScrollBehavior) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const node = findNearestNode(ratio);
      if (node) {
        scrollToTurn(node, behavior);
      }
    };

    jumpToPointer(event.clientY, "smooth");
    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      jumpToPointer(moveEvent.clientY, "auto");
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [findNearestNode, scrollToTurn, showPreview, visible]);

  const nearestNode = mouseYRatio === null ? null : findNearestNode(mouseYRatio);
  const nearestNodeIndex = nearestNode?.index ?? null;

  useEffect(() => {
    if (!minimapHovered || nearestNodeIndex === null) return;
    const previewBox = previewBoxRef.current;
    const previewItem = previewItemRefs.current.get(nearestNodeIndex);
    if (!previewBox || !previewItem) return;
    const targetTop = previewItem.offsetTop
      - (previewBox.clientHeight - previewItem.offsetHeight) / 2;
    previewBox.scrollTop = Math.max(0, targetTop);
  }, [allNodes, minimapHovered, nearestNodeIndex]);

  if (!visible) return null;

  const lastNodeTop = positionedNodes.length > 0
    ? positionedNodes[positionedNodes.length - 1].topRatio * minimapHeight
    : MINIMAP_PADDING;
  const railHeight = Math.max(1, lastNodeTop - MINIMAP_PADDING);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewHide}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMouseYRatio((event.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "pointer",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: MINIMAP_PADDING,
          height: railHeight,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {positionedNodes.map((node) => {
        const isNearest = minimapHovered && nearestNode?.index === node.index;
        const isActive = activeIndex === node.index;

        return (
          <div
            key={node.index}
            data-minimap-node-index={node.index}
            data-minimap-node-active={isActive ? "" : undefined}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: Math.max(1, nodeGap),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: isActive ? "rgba(128,128,128,0.42)" : "rgba(128,128,128,0.16)",
                border: `1.5px solid ${isActive ? "rgba(128,128,128,0.95)" : "rgba(128,128,128,0.58)"}`,
                boxShadow: isActive ? "0 0 0 2px var(--bg-panel)" : "none",
                transition: "transform 0.1s, background 0.1s",
                transform: isNearest ? "scale(1.25)" : "scale(1)",
              }}
            />
          </div>
        );
      })}

      <button
        type="button"
        className={styles.lock}
        data-minimap-lock={locked ? "on" : "off"}
        aria-pressed={locked}
        title={t(locked ? "chatMinimap.unlockPreview" : "chatMinimap.lockPreview")}
        aria-label={t("chatMinimap.lockPreview")}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          toggleLock();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          {locked ? (
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          ) : (
            <path d="M8 11V7a4 4 0 0 1 7.9-.9" />
          )}
        </svg>
      </button>

      {minimapHovered && allNodes.length > 0 && (
        <div
          ref={previewBoxRef}
          className={styles.preview}
          data-minimap-preview-box=""
          onMouseEnter={showPreview}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseMove={(event) => event.stopPropagation()}
        >
          {turns.map((turn) => {
            const isLocated = nearestNodeIndex === turn.index;
            const node = allNodes[turn.index];
            return (
              <div
                key={turn.index}
                ref={(element) => {
                  if (element) previewItemRefs.current.set(turn.index, element);
                  else previewItemRefs.current.delete(turn.index);
                }}
                className={styles.turn}
                data-minimap-preview-index={turn.index}
                data-located={isLocated ? "true" : undefined}
              >
                <span className={styles.number}>
                  <span aria-hidden="true">
                    {String(turn.index + 1).padStart(2, "0")}
                  </span>
                  {turn.toolCount > 0 && (
                    <span
                      className={styles.toolBadge}
                      role="img"
                      title={t("chatMinimap.toolCalls", { count: turn.toolCount })}
                      aria-label={t("chatMinimap.toolCalls", { count: turn.toolCount })}
                    >
                      {turn.toolCount > 99 ? "99+" : turn.toolCount}
                    </span>
                  )}
                </span>
                <div className={styles.content}>
                  <button
                    type="button"
                    className={styles.user}
                    data-minimap-preview-prompt={turn.index}
                    onClick={() => {
                      if (node) scrollToTurn(node, "smooth");
                    }}
                  >
                    <span className={styles.userText}>
                      {getPromptPreview(turn.prompt)}
                    </span>
                  </button>

                  {turn.answerMarkdown && (
                    <div className={styles.assistant}>
                      <button
                        type="button"
                        className={styles.assistantJump}
                        data-minimap-preview-answer={turn.index}
                        onClick={() => {
                          if (node) scrollToTurn(node, "smooth");
                        }}
                        aria-label={t("chatMinimap.locateAssistant")}
                        title={t("chatMinimap.locateAssistant")}
                      >
                        A
                      </button>
                      <AssistantOutline
                        markdown={turn.answerMarkdown}
                        onAnswerClick={() => {
                          if (node) scrollToTurn(node, "smooth");
                        }}
                        onHeadingClick={(headingIndex) => {
                          if (node) locateHeading(node, headingIndex);
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
