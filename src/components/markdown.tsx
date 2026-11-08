/**
 * <Markdown text streaming /> — the one boundary for rendering message markdown.
 * Parsing: src/lib/markdown.ts (marked lexer). Rendering: native Text/View styled after
 * T3's enriched-markdown theme (DESIGN.md §3.15). Code blocks and tables wider than the
 * message scroll horizontally inside themselves; nothing else ever does. Swap this file for
 * another renderer without touching screens.
 */

import * as WebBrowser from 'expo-web-browser';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text as RNText, useWindowDimensions, View } from 'react-native';

import { closeOpenFence, parseMarkdown, tableColumnWidths, type MdBlock, type MdInline } from '@/lib/markdown';
import { codeType, fontScaleCap, fonts, headingSizes, motion, radii, space, typeScale, useTheme, type Palette } from '@/theme';
import { Icon, Text } from '@/ui';

import { copyWithFeedback } from './copy';

export type MarkdownTone = 'assistant' | 'user';

type Look = {
  text: string;
  secondary: string;
  link: string | null;
  inlineCode: string;
  codeBg: string;
  codeBorder: string;
  codeText: string;
};

function lookFor(c: Palette, tone: MarkdownTone): Look {
  return tone === 'user'
    ? { text: c.text, secondary: c.text, link: null, inlineCode: c.inlineCode, codeBg: c.userCodeBg, codeBorder: 'transparent', codeText: c.text }
    : {
        text: c.text,
        secondary: c.textSecondary,
        link: c.accent,
        inlineCode: c.inlineCode,
        codeBg: c.codeBg,
        codeBorder: c.codeBorder,
        codeText: c.codeText,
      };
}

function openLink(href: string): void {
  if (/^https?:\/\//i.test(href)) void WebBrowser.openBrowserAsync(href).catch(() => Linking.openURL(href));
  else void Linking.openURL(href).catch(() => undefined);
}

function renderInline(nodes: MdInline[], look: Look, keyPrefix = 'i'): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.type) {
      case 'text':
        return n.text;
      case 'br':
        return '\n';
      case 'strong':
        return (
          <RNText key={key} style={styles.strong}>
            {renderInline(n.children, look, key)}
          </RNText>
        );
      case 'em':
        return (
          <RNText key={key} style={styles.em}>
            {renderInline(n.children, look, key)}
          </RNText>
        );
      case 'del':
        return (
          <RNText key={key} style={styles.del}>
            {renderInline(n.children, look, key)}
          </RNText>
        );
      case 'code':
        return (
          <RNText key={key} style={[styles.inlineCode, { color: look.inlineCode }]}>
            {n.text}
          </RNText>
        );
      case 'image':
        return n.alt ? (
          <RNText key={key} style={{ color: look.secondary }}>
            {n.alt}
          </RNText>
        ) : null;
      case 'link':
        return (
          <RNText
            key={key}
            accessibilityRole="link"
            accessibilityHint="Long-press to copy the address"
            onPress={() => openLink(n.href)}
            onLongPress={() => copyWithFeedback(n.href, 'Link copied')}
            style={look.link ? { color: look.link } : styles.userLink}
          >
            {renderInline(n.children, look, key)}
          </RNText>
        );
    }
  });
}

function CodeBlock({ lang, text, look }: { lang: string; text: string; look: Look }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <View style={[styles.code, { backgroundColor: look.codeBg, borderColor: look.codeBorder }]}>
      <View style={styles.codeTop}>
        {lang ? (
          <Text variant="micro" weight="medium" tone="tertiary" numberOfLines={1} style={styles.codeLang}>
            {lang}
          </Text>
        ) : (
          <View style={styles.codeLang} />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy code'}
          hitSlop={8}
          onPress={() => {
            copyWithFeedback(text, null);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), motion.copied);
          }}
          style={({ pressed }) => [styles.copy, pressed && { opacity: 0.7 }]}
        >
          {copied ? (
            <Text variant="micro" weight="medium" tone="success">
              Copied
            </Text>
          ) : null}
          <Icon name={copied ? 'checkmark' : 'doc.on.doc'} size={13} color={copied ? colors.success : colors.iconMuted} />
        </Pressable>
      </View>
      <ScrollView horizontal alwaysBounceHorizontal={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <RNText selectable style={[styles.codeText, { color: look.codeText }]}>
          {text}
        </RNText>
      </ScrollView>
    </View>
  );
}

/**
 * Every column gets its readable width (lib/markdown `tableColumnWidths`). A table that fits
 * stretches its columns to fill the message; one that does not scrolls sideways inside its
 * block, whatever its column count.
 */
function Table({ header, rows, look }: Extract<MdBlock, { type: 'table' }> & { look: Look }) {
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, fontScaleCap.footnote);
  const widths = useMemo(() => tableColumnWidths(header, rows, scale), [header, rows, scale]);
  return (
    <ScrollView
      horizontal
      alwaysBounceHorizontal={false}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tableScroll}
    >
      <View style={[styles.table, { borderColor: look.codeBorder }]}>
        {[header, ...rows].map((row, r) => (
          <View
            key={r}
            style={[
              styles.tableRow,
              r > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: look.codeBorder },
              r === 0 && { backgroundColor: look.codeBg },
            ]}
          >
            {widths.map((width, i) => (
              <View
                key={i}
                style={[
                  styles.cell,
                  // A definite width, not flexBasis: Yoga ignores flexBasis while it sizes a row
                  // inside an unbounded (horizontally scrolling) parent and measures the text
                  // instead, so every row got its own column widths.
                  { width, flexGrow: width },
                  i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: look.codeBorder },
                ]}
              >
                <Text variant="footnote" weight={r === 0 ? 'bold' : 'regular'} style={{ color: look.text }}>
                  {row[i] ? renderInline(row[i], look) : null}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const BOTTOM: Record<MdBlock['type'], number> = { paragraph: 8, heading: 8, code: 12, blockquote: 8, list: 8, hr: 8, table: 12 };
const TOP: Record<MdBlock['type'], number> = { paragraph: 0, heading: 8, code: 4, blockquote: 0, list: 0, hr: 0, table: 4 };

function Blocks({ blocks, look, depth = 0, itemGap }: { blocks: MdBlock[]; look: Look; depth?: number; itemGap?: number }) {
  return (
    <>
      {blocks.map((b, i) => {
        const marginTop = i === 0 ? 0 : (itemGap ?? BOTTOM[blocks[i - 1].type] + TOP[b.type]);
        let node: ReactNode;
        switch (b.type) {
          case 'paragraph':
            node = (
              <Text variant="body" style={{ color: look.text }}>
                {renderInline(b.children, look)}
              </Text>
            );
            break;
          case 'heading': {
            const size = headingSizes[Math.min(Math.max(b.depth, 1), 6) - 1];
            node = (
              <Text
                variant="body"
                weight="bold"
                accessibilityRole="header"
                style={{ fontSize: size, lineHeight: Math.round(size * 1.35), color: look.text }}
              >
                {renderInline(b.children, look)}
              </Text>
            );
            break;
          }
          case 'code':
            node = <CodeBlock lang={b.lang} text={b.text} look={look} />;
            break;
          case 'blockquote':
            node = (
              <View style={[styles.quote, { borderLeftColor: look.codeBorder === 'transparent' ? look.inlineCode : look.codeBorder }]}>
                <Blocks blocks={b.children} look={{ ...look, text: look.secondary }} depth={depth} />
              </View>
            );
            break;
          case 'list':
            node = (
              <View style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.listItem}>
                    <View style={styles.marker}>
                      {item.task ? (
                        <Icon
                          name={item.checked ? 'checkmark.square.fill' : 'square'}
                          size={14}
                          color={item.checked ? look.link ?? look.text : look.secondary}
                          style={styles.taskBox}
                        />
                      ) : (
                        <Text variant="body" style={{ color: look.secondary }}>
                          {b.ordered ? `${b.start + j}.` : depth % 2 === 0 ? '•' : '◦'}
                        </Text>
                      )}
                    </View>
                    <View style={styles.listBody}>
                      <Blocks blocks={item.children} look={look} depth={depth + 1} itemGap={space.xs} />
                    </View>
                  </View>
                ))}
              </View>
            );
            break;
          case 'hr':
            node = <View style={[styles.hr, { backgroundColor: look.codeBorder === 'transparent' ? look.inlineCode : look.codeBorder }]} />;
            break;
          case 'table':
            node = <Table {...b} look={look} />;
            break;
        }
        return (
          <View key={i} style={marginTop ? { marginTop } : undefined}>
            {node}
          </View>
        );
      })}
    </>
  );
}

/** Re-renders a fast-changing string at most once per animation frame. */
function useFrameThrottled(value: string, enabled: boolean): string {
  const [shown, setShown] = useState(value);
  const frame = useRef<number | null>(null);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
    if (!enabled) return;
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setShown(latest.current);
      });
    }
  }, [value, enabled]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return enabled ? shown : value;
}

export const Markdown = memo(function Markdown({
  text,
  streaming,
  tone = 'assistant',
}: {
  text: string;
  streaming?: boolean;
  tone?: MarkdownTone;
}) {
  const { colors } = useTheme();
  const shown = useFrameThrottled(text, !!streaming);
  const blocks = useMemo(() => parseMarkdown(streaming ? closeOpenFence(shown) : shown), [shown, streaming]);
  const look = useMemo(() => lookFor(colors, tone), [colors, tone]);
  return (
    <View>
      <Blocks blocks={blocks} look={look} />
    </View>
  );
});

const styles = StyleSheet.create({
  strong: { fontFamily: fonts.bold },
  em: { fontFamily: fonts.italic },
  del: { textDecorationLine: 'line-through' },
  inlineCode: { fontFamily: fonts.mono, fontSize: typeScale.body.fontSize * 0.9 },
  userLink: { textDecorationLine: 'underline' },
  code: { borderRadius: radii.sm, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  codeTop: { flexDirection: 'row', alignItems: 'center', minHeight: 28, paddingLeft: space.md, paddingRight: space.xs },
  codeLang: { flex: 1 },
  copy: { minWidth: 28, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  codeScroll: { paddingHorizontal: space.md, paddingBottom: space.md },
  codeText: { fontFamily: fonts.mono, ...codeType },
  quote: { borderLeftWidth: 2, paddingLeft: space.md },
  list: { gap: space.xs },
  listItem: { flexDirection: 'row', gap: 6 },
  marker: { width: 20, alignItems: 'flex-end' },
  taskBox: { marginTop: 4 },
  listBody: { flex: 1 },
  hr: { height: 1, marginVertical: space.xs },
  // Fill the block when the table is narrower than it; overflow (and scroll) when wider.
  tableScroll: { flexGrow: 1 },
  table: { flexGrow: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
  cell: { flexShrink: 0, paddingHorizontal: 10, paddingVertical: 7 },
});
