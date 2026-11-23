import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  FlatList, Alert, TextInput, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { PodsStackParamList, Pod, Activity, Message, User, PodCategory } from '../../types';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { getPod, joinPod, leavePod, grantAdmin, removeAdmin, updatePod, deletePod } from '../../services/pods';
import { getUserProfiles } from '../../services/auth';
import { getActivitiesForPod, requestJoinActivity } from '../../services/activities';
import { sendPodMessage, subscribeToPodMessages } from '../../services/chat';
import { POD_CATEGORIES } from '../../constants/categories';
import { PodBannerColors } from '../../constants/colors';
import CategoryChip from '../../components/CategoryChip';
import ActivityCard from '../../components/ActivityCard';
import AvatarInitials from '../../components/AvatarInitials';
import MessageBubble from '../../components/MessageBubble';
import KeyboardAwareView from '../../components/KeyboardAwareView';

type Props = {
  navigation: NativeStackNavigationProp<PodsStackParamList, 'PodDetail'>;
  route: RouteProp<PodsStackParamList, 'PodDetail'>;
};

type Tab = 'Chat' | 'Activities' | 'Members' | 'Info';
const TABS: Tab[] = ['Chat', 'Activities', 'Members', 'Info'];

export default function PodDetailScreen({ navigation, route }: Props) {
  const { podId } = route.params;
  const { colors } = useTheme();
  const { userProfile, refreshProfile } = useAuth();

  const [pod, setPod] = useState<Pod | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [tab, setTab] = useState<Tab>('Chat');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatText, setChatText] = useState('');
  const [sending, setSending] = useState(false);
  const chatListRef = useRef<FlatList>(null);

  // Members state
  const [memberProfiles, setMemberProfiles] = useState<Record<string, User>>({});
  const [selectedMember, setSelectedMember] = useState<User | null>(null);
  const [memberModalVisible, setMemberModalVisible] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);

  // Edit pod state (admin)
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategory, setEditCategory] = useState<PodCategory>('Social');
  const [editBannerColor, setEditBannerColor] = useState(PodBannerColors[0]);
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [podData, activityData] = await Promise.all([
        getPod(podId),
        getActivitiesForPod(podId),
      ]);
      setPod(podData);
      setActivities(activityData);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load pod');
    } finally {
      setLoading(false);
    }
  }, [podId]);

  // Reload whenever the screen comes back into view (e.g. after creating something).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const uid = userProfile?.uid ?? '';
  // Derived from loaded pod (null until loaded) — safe default false.
  const isMember = pod?.members.includes(uid) ?? false;
  const isAdmin = pod?.admins.includes(uid) ?? false;

  // Subscribe to pod chat — members only. Non-members see the join prompt
  // instead of other people's messages (also enforced by security rules).
  useEffect(() => {
    if (!isMember) return;
    const unsub = subscribeToPodMessages(podId, (msgs) => {
      setMessages(msgs);
      setTimeout(() => chatListRef.current?.scrollToEnd({ animated: true }), 100);
    });
    return unsub;
  }, [podId, isMember]);

  // Fetch member profiles when pod data is available
  useEffect(() => {
    if (!pod) return;
    let cancelled = false;
    // One query for all members; on failure names fall back to "Member".
    getUserProfiles(pod.members)
      .then((profiles) => { if (!cancelled) setMemberProfiles(profiles); })
      .catch((err: unknown) => console.warn('Could not load member profiles', err));
    return () => { cancelled = true; };
  }, [pod?.members.length]);

  const s = makeStyles(colors);

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={colors.primary} /></View>;

  if (error || !pod) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>{error ?? 'Pod not found'}</Text>
        <TouchableOpacity onPress={load} style={s.retryBtn}>
          <Text style={s.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleJoin = async () => {
    try { await joinPod(podId, uid); await refreshProfile(); await load(); }
    catch (err: any) { Alert.alert('Error', err.message); }
  };

  const handleLeave = () => Alert.alert('Leave Pod', `Leave ${pod?.name ?? 'this pod'}?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: async () => {
      try { await leavePod(podId, uid); await refreshProfile(); navigation.goBack(); }
      catch (err: any) { Alert.alert('Error', err.message); }
    }},
  ]);

  const openEditModal = () => {
    if (!pod) return;
    setEditName(pod.name);
    setEditDescription(pod.description);
    setEditCategory(pod.category);
    setEditBannerColor(pod.bannerColor);
    setEditModalVisible(true);
  };

  const handleSaveEdit = async () => {
    if (!editName.trim()) return Alert.alert('Error', 'Pod name cannot be empty');
    setSavingEdit(true);
    try {
      await updatePod(podId, uid, {
        name: editName.trim(),
        description: editDescription.trim(),
        category: editCategory,
        bannerColor: editBannerColor,
      });
      setEditModalVisible(false);
      await load();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeletePod = () => Alert.alert(
    'Delete Pod',
    `Delete "${pod?.name ?? 'this pod'}" and all its activities and chats? This cannot be undone.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await deletePod(podId, uid);
          await refreshProfile();
          navigation.goBack();
        } catch (err: any) {
          Alert.alert('Error', err.message);
        }
      }},
    ]
  );

  const handleRequestJoin = async (activityId: string) => {
    try { await requestJoinActivity(activityId, uid); await load(); }
    catch (err: any) { Alert.alert('Error', err.message); }
  };

  const handleSendMessage = async () => {
    if (!chatText.trim() || !userProfile) return;
    setSending(true);
    try { await sendPodMessage(podId, uid, userProfile.displayName, chatText.trim()); setChatText(''); }
    finally { setSending(false); }
  };

  const handleMemberTap = (memberId: string) => {
    const profile = memberProfiles[memberId];
    if (profile) {
      setSelectedMember(profile);
      setMemberModalVisible(true);
    }
  };

  const handleGrantAdmin = async (memberId: string) => {
    setAdminLoading(true);
    try {
      await grantAdmin(podId, memberId);
      await load();
      Alert.alert('Success', `${memberProfiles[memberId]?.displayName ?? 'Member'} is now an admin.`);
      setMemberModalVisible(false);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Failed to grant admin');
    } finally {
      setAdminLoading(false);
    }
  };

  const handleRemoveAdmin = async (memberId: string) => {
    setAdminLoading(true);
    try {
      await removeAdmin(podId, memberId);
      await load();
      Alert.alert('Success', `${memberProfiles[memberId]?.displayName ?? 'Member'} is no longer an admin.`);
      setMemberModalVisible(false);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Failed to remove admin');
    } finally {
      setAdminLoading(false);
    }
  };

  const renderContent = () => {
    if (tab === 'Chat') {
      return (
        <KeyboardAwareView onKeyboardShown={() => chatListRef.current?.scrollToEnd({ animated: true })}>
          <FlatList
            ref={chatListRef}
            data={isMember ? messages : []}
            keyExtractor={(m) => m.messageId}
            renderItem={({ item }) => <MessageBubble message={item} isOwn={item.senderId === uid} />}
            contentContainerStyle={s.chatList}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => chatListRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={
              <View style={s.chatEmpty}>
                <Text style={s.chatEmptyIcon}>💬</Text>
                <Text style={s.chatEmptyText}>No messages yet. Say hi to your pod!</Text>
              </View>
            }
          />
          {isMember ? (
            <View style={s.inputBar}>
              <TextInput
                style={s.textInput}
                placeholder="Message the pod..."
                placeholderTextColor={colors.subtext}
                value={chatText}
                onChangeText={setChatText}
                multiline
                maxLength={500}
              />
              <TouchableOpacity
                style={[s.sendBtn, (!chatText.trim() || sending) && s.sendBtnDisabled]}
                onPress={handleSendMessage}
                disabled={!chatText.trim() || sending}
              >
                {sending ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="send" size={18} color="#FFFFFF" />}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.joinToChat}>
              <Text style={s.joinToChatText}>Join this pod to participate in the chat</Text>
            </View>
          )}
        </KeyboardAwareView>
      );
    }

    if (tab === 'Activities') {
      return (
        <FlatList
          data={activities}
          keyExtractor={(a) => a.activityId}
          renderItem={({ item }) => (
            <ActivityCard activity={item} currentUserId={uid}
              onPress={() => navigation.navigate('ActivityDetail', { activityId: item.activityId })}
              onRequestJoin={() => handleRequestJoin(item.activityId)} />
          )}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyIcon}>📅</Text>
              <Text style={s.emptyTitle}>No activities yet</Text>
              <Text style={s.emptyText}>Be the first to create one!</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
        />
      );
    }

    if (tab === 'Members') {
      return (
        <FlatList
          data={pod.members}
          keyExtractor={(m) => m}
          renderItem={({ item: memberId }) => {
            const profile = memberProfiles[memberId];
            const name = profile?.displayName ?? (memberId === uid ? userProfile?.displayName ?? 'You' : 'Loading...');
            const isMe = memberId === uid;
            return (
              <TouchableOpacity style={s.memberRow} onPress={() => handleMemberTap(memberId)} activeOpacity={0.6}>
                <AvatarInitials name={name} size={40} />
                <View style={s.memberInfo}>
                  <Text style={s.memberName}>{name}{isMe ? ' (You)' : ''}</Text>
                  {pod.admins.includes(memberId) && <Text style={s.adminBadge}>Admin</Text>}
                  {profile?.university ? <Text style={s.memberUniversity}>{profile.university}</Text> : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={s.memberList}
          showsVerticalScrollIndicator={false}
        />
      );
    }

    // Info tab
    return (
      <View style={s.infoTab}>
        {[
          { label: 'Category', value: pod.category },
          { label: 'Members', value: `${pod.memberCount}` },
          { label: 'Visibility', value: pod.visibility === 'public' ? 'Public' : 'Private' },
          { label: 'Created', value: new Date(pod.createdAt).toLocaleDateString() },
        ].map((item) => (
          <View key={item.label} style={s.infoRow}>
            <Text style={s.infoLabel}>{item.label}</Text>
            <Text style={s.infoValue}>{item.value}</Text>
          </View>
        ))}
        {isMember && pod.inviteCode ? (
          <View style={s.inviteCodeBox}>
            <View>
              <Text style={s.inviteCodeLabel}>Invite Code</Text>
              <Text style={s.inviteCodeHint}>Share it to let others join</Text>
            </View>
            <Text style={[s.inviteCodeValue, { color: colors.primary }]}>{pod.inviteCode}</Text>
          </View>
        ) : null}
        <Text style={s.infoDescription}>{pod.description}</Text>
        {isMember && (
          <TouchableOpacity style={s.leaveBtn} onPress={handleLeave}>
            <Text style={s.leaveBtnText}>Leave Pod</Text>
          </TouchableOpacity>
        )}
        {isAdmin && (
          <>
            <TouchableOpacity style={s.editPodBtn} onPress={openEditModal}>
              <Text style={s.editPodBtnText}>Edit Pod</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.deletePodBtn} onPress={handleDeletePod}>
              <Text style={s.deletePodBtnText}>Delete Pod</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={[s.banner, { backgroundColor: pod.bannerColor }]}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={s.bannerContent}>
          <Text style={s.bannerLetter}>{pod.name[0]}</Text>
        </View>
      </View>

      <View style={s.podHeader}>
        <View style={s.podInfo}>
          <Text style={s.podName}>{pod.name}</Text>
          <Text style={s.podMeta}>{pod.memberCount} members · {pod.category}</Text>
        </View>
        {!isMember && (
          <TouchableOpacity style={s.joinBtn} onPress={handleJoin}>
            <Text style={s.joinBtnText}>Join</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={s.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity key={t} style={[s.tab, tab === t && s.tabActive]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ flex: 1 }}>
        {renderContent()}
      </View>

      {isMember && tab === 'Activities' && (
        <TouchableOpacity style={s.fab} onPress={() => navigation.navigate('CreateActivity', { podId })}>
          <Ionicons name="add" size={28} color="#FFFFFF" />
        </TouchableOpacity>
      )}

      {/* Member Profile Modal */}
      <Modal
        visible={memberModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setMemberModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={[s.modalContent, { backgroundColor: colors.card }]}>
            <View style={s.modalHeader}>
              <Text style={[s.modalTitle, { color: colors.text }]}>Member Profile</Text>
              <TouchableOpacity onPress={() => setMemberModalVisible(false)}>
                <Ionicons name="close" size={24} color={colors.subtext} />
              </TouchableOpacity>
            </View>

            {selectedMember && (
              <View style={s.profileSection}>
                <AvatarInitials name={selectedMember.displayName} size={72} />
                <Text style={[s.profileName, { color: colors.text }]}>{selectedMember.displayName}</Text>
                <Text style={[s.profileEmail, { color: colors.subtext }]}>{selectedMember.email}</Text>
                {selectedMember.university ? (
                  <Text style={[s.profileUniversity, { color: colors.primary }]}>{selectedMember.university}</Text>
                ) : null}

                <View style={s.profileStats}>
                  <View style={s.statItem}>
                    <Text style={[s.statNumber, { color: colors.text }]}>{selectedMember.podsJoined?.length ?? 0}</Text>
                    <Text style={[s.statLabel, { color: colors.subtext }]}>Pods</Text>
                  </View>
                  <View style={s.statItem}>
                    <Text style={[s.statNumber, { color: colors.text }]}>{selectedMember.postsCount ?? 0}</Text>
                    <Text style={[s.statLabel, { color: colors.subtext }]}>Posts</Text>
                  </View>
                  <View style={s.statItem}>
                    <Text style={[s.statNumber, { color: colors.text }]}>{selectedMember.commendations ?? 0}</Text>
                    <Text style={[s.statLabel, { color: colors.subtext }]}>Kudos</Text>
                  </View>
                </View>

                {selectedMember.bio ? (
                  <Text style={[s.profileBio, { color: colors.text }]}>{selectedMember.bio}</Text>
                ) : null}

                <Text style={[s.profileJoinDate, { color: colors.subtext }]}>
                  Joined {new Date(selectedMember.joinDate).toLocaleDateString()}
                </Text>

                {/* Admin actions — only show if current user is admin AND the selected member is not themselves */}
                {isAdmin && selectedMember.uid !== uid && (
                  <View style={s.adminActions}>
                    {pod.admins.includes(selectedMember.uid) ? (
                      <TouchableOpacity
                        style={[s.adminActionBtn, { borderColor: colors.danger }]}
                        onPress={() => Alert.alert(
                          'Remove Admin',
                          `Remove admin privileges from ${selectedMember.displayName}?`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Remove', style: 'destructive', onPress: () => handleRemoveAdmin(selectedMember.uid) },
                          ]
                        )}
                        disabled={adminLoading}
                      >
                        {adminLoading ? (
                          <ActivityIndicator size="small" color={colors.danger} />
                        ) : (
                          <Text style={[s.adminActionText, { color: colors.danger }]}>Remove Admin</Text>
                        )}
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        style={[s.adminActionBtn, { borderColor: colors.primary }]}
                        onPress={() => Alert.alert(
                          'Grant Admin',
                          `Make ${selectedMember.displayName} an admin of this pod?`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Grant Admin', onPress: () => handleGrantAdmin(selectedMember.uid) },
                          ]
                        )}
                        disabled={adminLoading}
                      >
                        {adminLoading ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <Text style={[s.adminActionText, { color: colors.primary }]}>Grant Admin</Text>
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            )}
          </View>
        </View>
      </Modal>
      {/* Edit Pod Modal (admin) */}
      <Modal
        visible={editModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setEditModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={[s.modalContent, { backgroundColor: colors.card }]}>
            <View style={s.modalHeader}>
              <Text style={[s.modalTitle, { color: colors.text }]}>Edit Pod</Text>
              <TouchableOpacity onPress={() => setEditModalVisible(false)}>
                <Ionicons name="close" size={24} color={colors.subtext} />
              </TouchableOpacity>
            </View>
            <View style={s.editForm}>
              <Text style={s.editLabel}>Pod Name</Text>
              <TextInput
                style={[s.editInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
                value={editName}
                onChangeText={setEditName}
                maxLength={50}
                placeholderTextColor={colors.subtext}
              />
              <Text style={s.editLabel}>Description</Text>
              <TextInput
                style={[s.editInput, s.editTextarea, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBackground }]}
                value={editDescription}
                onChangeText={setEditDescription}
                multiline
                numberOfLines={3}
                maxLength={200}
                placeholderTextColor={colors.subtext}
              />
              <Text style={s.editLabel}>Category</Text>
              <View style={s.editChipsRow}>
                {POD_CATEGORIES.map((cat) => (
                  <CategoryChip key={cat} label={cat} selected={editCategory === cat} onPress={() => setEditCategory(cat)} small />
                ))}
              </View>
              <Text style={s.editLabel}>Banner Color</Text>
              <View style={s.editColorRow}>
                {PodBannerColors.map((color) => (
                  <TouchableOpacity
                    key={color}
                    style={[s.editColorSwatch, { backgroundColor: color }, editBannerColor === color && s.editColorSwatchSelected]}
                    onPress={() => setEditBannerColor(color)}
                  >
                    {editBannerColor === color && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={s.editSaveBtn} onPress={handleSaveEdit} disabled={savingEdit}>
                {savingEdit
                  ? <ActivityIndicator size="small" color="#FFFFFF" />
                  : <Text style={s.editSaveBtnText}>Save Changes</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: c.background },
  errorText: { fontSize: 15, color: c.subtext, textAlign: 'center', marginBottom: 16 },
  retryBtn: { backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
  retryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  banner: { height: 140, justifyContent: 'space-between' },
  backBtn: { padding: 16 },
  bannerContent: { paddingHorizontal: 20, paddingBottom: 16 },
  bannerLetter: { fontSize: 40, fontWeight: '900', color: 'rgba(255,255,255,0.5)' },
  podHeader: { flexDirection: 'row', alignItems: 'center', padding: 20 },
  podInfo: { flex: 1 },
  podName: { fontSize: 22, fontWeight: '800', color: c.text },
  podMeta: { fontSize: 14, color: c.subtext, marginTop: 3 },
  joinBtn: { backgroundColor: c.primary, borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10 },
  joinBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  tab: { flex: 1, paddingVertical: 13, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2.5, borderBottomColor: c.primary },
  tabText: { fontSize: 13, fontWeight: '600', color: c.subtext },
  tabTextActive: { color: c.primary },
  // Chat
  chatList: { paddingVertical: 12, paddingBottom: 8 },
  chatEmpty: { alignItems: 'center', paddingTop: 60 },
  chatEmptyIcon: { fontSize: 40, marginBottom: 12 },
  chatEmptyText: { fontSize: 14, color: c.subtext, textAlign: 'center' },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card, gap: 10 },
  textInput: { flex: 1, backgroundColor: c.inputBackground, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: c.text, maxHeight: 100, borderWidth: 1.5, borderColor: c.border },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  joinToChat: { padding: 16, alignItems: 'center', borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
  joinToChatText: { color: c.subtext, fontSize: 14 },
  // Activities
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 6 },
  emptyText: { fontSize: 14, color: c.subtext },
  // Members
  memberRow: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border },
  memberInfo: { marginLeft: 14, flex: 1 },
  memberName: { fontSize: 15, fontWeight: '600', color: c.text },
  adminBadge: { fontSize: 12, color: c.primary, fontWeight: '500', marginTop: 2 },
  memberUniversity: { fontSize: 12, color: c.subtext, marginTop: 2 },
  memberList: { paddingHorizontal: 4 },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40, maxHeight: '80%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: c.border },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  // Profile section inside modal
  profileSection: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 20 },
  profileName: { fontSize: 22, fontWeight: '800', marginTop: 14 },
  profileEmail: { fontSize: 14, marginTop: 4 },
  profileUniversity: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  profileStats: { flexDirection: 'row', marginTop: 20, gap: 32 },
  statItem: { alignItems: 'center' },
  statNumber: { fontSize: 20, fontWeight: '700' },
  statLabel: { fontSize: 12, marginTop: 2 },
  profileBio: { fontSize: 14, textAlign: 'center', marginTop: 16, lineHeight: 20, paddingHorizontal: 12 },
  profileJoinDate: { fontSize: 12, marginTop: 12 },
  adminActions: { marginTop: 24, width: '100%', paddingHorizontal: 12 },
  adminActionBtn: { borderWidth: 1.5, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  adminActionText: { fontWeight: '600', fontSize: 15 },
  // Info
  infoTab: { padding: 20 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border },
  infoLabel: { fontSize: 14, color: c.subtext },
  infoValue: { fontSize: 14, fontWeight: '600', color: c.text },
  infoDescription: { marginTop: 20, fontSize: 15, color: c.text, lineHeight: 22 },
  inviteCodeBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, backgroundColor: c.primaryGlow, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14 },
  inviteCodeLabel: { fontSize: 13, fontWeight: '700', color: c.text },
  inviteCodeHint: { fontSize: 12, color: c.subtext, marginTop: 2 },
  inviteCodeValue: { fontSize: 22, fontWeight: '800', letterSpacing: 3 },
  leaveBtn: { marginTop: 32, borderWidth: 1.5, borderColor: c.danger, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  leaveBtnText: { color: c.danger, fontWeight: '600', fontSize: 15 },
  editPodBtn: { marginTop: 12, borderWidth: 1.5, borderColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  editPodBtnText: { color: c.primary, fontWeight: '600', fontSize: 15 },
  deletePodBtn: { marginTop: 12, borderRadius: 12, paddingVertical: 14, alignItems: 'center', backgroundColor: c.danger },
  deletePodBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  // Edit pod modal
  editForm: { padding: 20, paddingBottom: 32 },
  editLabel: { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 8, marginTop: 14 },
  editInput: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15, borderWidth: 1.5 },
  editTextarea: { height: 80, textAlignVertical: 'top' },
  editChipsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  editColorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  editColorSwatch: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  editColorSwatchSelected: { borderWidth: 3, borderColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 4 },
  editSaveBtn: { marginTop: 24, backgroundColor: c.primary, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  editSaveBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', shadowColor: c.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 6 },
});