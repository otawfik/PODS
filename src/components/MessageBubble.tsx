import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Message } from '../types';
import { useTheme } from '../context/ThemeContext';
import { senderColor } from '../utils/chatLayout';
import AvatarInitials from './AvatarInitials';

interface Props {
  message: Message;
  isOwn: boolean;
  /** Long-press action (report), for other people's messages. */
  onLongPress?: () => void;
  /** First bubble of a run from one sender: shows their name. Default true. */
  groupStart?: boolean;
  /** Last bubble of a run: shows the avatar and the tail corner. Default true. */
  groupEnd?: boolean;
}

const AVATAR = 28;

export default function MessageBubble({
  message,
  isOwn,
  onLongPress,
  groupStart = true,
  groupEnd = true,
}: Props) {
  const { colors } = useTheme();
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const metaColor = isOwn ? 'rgba(255,255,255,0.75)' : colors.subtext;

  return (
    <View style={[styles.row, isOwn && styles.rowOwn, { marginTop: groupStart ? 8 : 2 }]}>
      {!isOwn && (
        <View style={styles.avatarSlot}>
          {groupEnd ? (
            <AvatarInitials
              name={message.senderName}
              size={AVATAR}
              backgroundColor={senderColor(message.senderId)}
            />
          ) : null}
        </View>
      )}
      <Pressable
        onLongPress={onLongPress}
        disabled={!onLongPress}
        accessibilityLabel={`${isOwn ? 'You' : message.senderName}: ${message.message}, ${time}`}
        accessibilityHint={onLongPress ? 'Long press to report this message' : undefined}
        style={[
          styles.bubble,
          isOwn
            ? { backgroundColor: colors.primary }
            : {
                backgroundColor: colors.elevatedCard,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
              },
          // The tail: the corner nearest the sender is squared on the last bubble of a run.
          groupEnd && (isOwn ? styles.tailOwn : styles.tailOther),
        ]}
      >
        {!isOwn && groupStart && (
          <Text
            style={[styles.senderName, { color: senderColor(message.senderId) }]}
            numberOfLines={1}
          >
            {message.senderName}
          </Text>
        )}
        <Text style={[styles.messageText, { color: isOwn ? '#FFFFFF' : colors.text }]}>
          {message.message}
          {/* Invisible spacer so the last line of text never runs under the time. */}
          <Text style={styles.timeSpacer}>{`  ${time} `}</Text>
        </Text>
        <Text style={[styles.time, { color: metaColor }]}>{time}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', marginHorizontal: 10 },
  rowOwn: { justifyContent: 'flex-end' },
  avatarSlot: { width: AVATAR, marginRight: 6 },
  bubble: {
    maxWidth: '78%',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 7,
    paddingBottom: 7,
  },
  tailOwn: { borderBottomRightRadius: 4 },
  tailOther: { borderBottomLeftRadius: 4 },
  senderName: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  messageText: { fontSize: 16, lineHeight: 21 },
  timeSpacer: { fontSize: 11, color: 'transparent' },
  time: { position: 'absolute', right: 10, bottom: 6, fontSize: 11 },
});
