import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Pod, PodCategory } from '../../types';
import { POD_CATEGORIES } from '../../constants/categories';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { getPublicPods, joinPod, joinPodWithCode } from '../../services/pods';
import { getPodRecommendations, PodRecommendation } from '../../services/recommendations';
import PodCard from '../../components/PodCard';
import CategoryChip from '../../components/CategoryChip';

type AnyStackWithPodDiscovery = { PodDiscovery: undefined; PodDetail: { podId: string }; [key: string]: object | undefined };
type Props = { navigation: NativeStackNavigationProp<AnyStackWithPodDiscovery, 'PodDiscovery'> };

export default function PodDiscoveryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { userProfile, refreshProfile } = useAuth();
  const [pods, setPods] = useState<Pod[]>([]);
  const [search, setSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState<PodCategory | null>(null);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [joiningWithCode, setJoiningWithCode] = useState(false);
  const [recs, setRecs] = useState<PodRecommendation[]>([]);
  const [recsState, setRecsState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => { getPublicPods().then((d) => { setPods(d); setLoading(false); }); }, []);
  useEffect(() => {
    let cancelled = false;
    getPodRecommendations()
      .then((r) => { if (!cancelled) { setRecs(r); setRecsState('ready'); } })
      .catch((err: unknown) => {
        console.warn('Could not load recommendations', err);
        if (!cancelled) setRecsState('error');
      });
    return () => { cancelled = true; };
  }, []);
  const filtered = useMemo(() => {
    let r = pods;
    if (selectedCat) r = r.filter((p) => p.category === selectedCat);
    if (search.trim()) { const t = search.toLowerCase(); r = r.filter((p) => p.name.toLowerCase().includes(t) || p.description.toLowerCase().includes(t)); }
    return r;
  }, [pods, search, selectedCat]);

  const handleJoin = async (pod: Pod) => {
    if (!userProfile) return;
    setJoiningId(pod.podId);
    try { await joinPod(pod.podId, userProfile.uid); await refreshProfile(); navigation.navigate('PodDetail', { podId: pod.podId }); }
    catch (err: any) { Alert.alert('Error', err.message); }
    finally { setJoiningId(null); }
  };

  const handleJoinWithCode = async () => {
    if (!userProfile) return;
    if (!inviteCode.trim()) return Alert.alert('Enter a code', 'Type the invite code shared by a pod member.');
    setJoiningWithCode(true);
    try {
      const podId = await joinPodWithCode(inviteCode, userProfile.uid);
      await refreshProfile();
      setInviteCode('');
      navigation.navigate('PodDetail', { podId });
    } catch (err: any) {
      Alert.alert('Could not join', err.message ?? 'Invalid invite code');
    } finally {
      setJoiningWithCode(false);
    }
  };

  const s = makeStyles(colors);

  // Recommended pods that are still loaded and not yet joined.
  const podsById = new Map(pods.map((p) => [p.podId, p]));
  const recommended = recs
    .map((r) => ({ rec: r, pod: podsById.get(r.podId) }))
    .filter((x): x is { rec: PodRecommendation; pod: Pod } =>
      !!x.pod && !(userProfile?.podsJoined.includes(x.rec.podId) ?? false));
  const showRecs = !search.trim() && !selectedCat;
  const hasInterests = (userProfile?.interests.length ?? 0) > 0;

  const recommendedHeader = showRecs ? (
    <View style={s.recsSection}>
      <Text style={s.recsTitle}>Recommended for you</Text>
      {recsState === 'loading' && (
        <View style={s.recsStatus}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={s.recsStatusText}>Finding pods that fit you...</Text>
        </View>
      )}
      {recsState === 'error' && (
        <Text style={s.recsStatusText}>Recommendations are unavailable right now.</Text>
      )}
      {recsState === 'ready' && recommended.length === 0 && (
        <Text style={s.recsStatusText}>
          {hasInterests
            ? 'No new matches right now. Check back as more pods start.'
            : 'Add interests on your profile to get recommendations.'}
        </Text>
      )}
      {recommended.map(({ rec, pod }) => (
        <PodCard key={`rec-${pod.podId}`} pod={pod} reason={rec.reason}
          onPress={() => navigation.navigate('PodDetail', { podId: pod.podId })}
          onJoin={() => handleJoin(pod)} />
      ))}
      <Text style={s.allTitle}>All pods</Text>
    </View>
  ) : null;

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Discover Pods</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={s.inviteRow}>
        <View style={s.inviteInputContainer}>
          <Ionicons name="ticket-outline" size={18} color={colors.subtext} style={s.searchIcon} />
          <TextInput
            style={s.searchInput}
            placeholder="Have an invite code?"
            placeholderTextColor={colors.subtext}
            value={inviteCode}
            onChangeText={(t) => setInviteCode(t.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={12}
          />
        </View>
        <TouchableOpacity
          style={[s.inviteBtn, joiningWithCode && s.inviteBtnDisabled]}
          onPress={handleJoinWithCode}
          disabled={joiningWithCode}
        >
          {joiningWithCode
            ? <ActivityIndicator size="small" color="#FFFFFF" />
            : <Text style={s.inviteBtnText}>Join</Text>}
        </TouchableOpacity>
      </View>

      <View style={s.searchContainer}>
        <Ionicons name="search" size={18} color={colors.subtext} style={s.searchIcon} />
        <TextInput style={s.searchInput} placeholder="Search pods..." placeholderTextColor={colors.subtext}
          value={search} onChangeText={setSearch} autoCapitalize="none" />
      </View>

      <View style={s.filterRow}>
        <TouchableOpacity style={[s.allChip, !selectedCat && s.allChipSelected]} onPress={() => setSelectedCat(null)}>
          <Text style={[s.allChipText, !selectedCat && s.allChipTextSelected]}>All</Text>
        </TouchableOpacity>
        {POD_CATEGORIES.map((cat) => (
          <CategoryChip key={cat} label={cat} selected={selectedCat === cat}
            onPress={() => setSelectedCat(selectedCat === cat ? null : cat)} small />
        ))}
      </View>

      {loading ? <View style={s.center}><ActivityIndicator size="large" color={colors.primary} /></View> : (
        <FlatList data={filtered} keyExtractor={(item) => item.podId}
          ListHeaderComponent={recommendedHeader}
          renderItem={({ item }) => {
            const isMember = userProfile?.podsJoined.includes(item.podId) ?? false;
            return (
              <PodCard pod={item} isMember={isMember}
                onPress={() => navigation.navigate('PodDetail', { podId: item.podId })}
                onJoin={!isMember ? () => handleJoin(item) : undefined} />
            );
          }}
          ListEmptyComponent={<View style={s.empty}><Text style={s.emptyText}>No pods found</Text></View>}
          contentContainerStyle={{ paddingBottom: 30 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 },
  title: { fontSize: 20, fontWeight: '700', color: c.text },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.inputBackground, borderRadius: 12, marginHorizontal: 16, marginBottom: 12, paddingHorizontal: 14, borderWidth: 1.5, borderColor: c.border },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 15, color: c.text },
  inviteRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 12, gap: 10 },
  inviteInputContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1.5, borderColor: c.border, borderStyle: 'dashed' },
  inviteBtn: { backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  inviteBtnDisabled: { opacity: 0.5 },
  inviteBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  filterRow: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 12, flexWrap: 'nowrap' },
  allChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: c.primaryGlow, marginRight: 8 },
  allChipSelected: { backgroundColor: c.primary },
  allChipText: { fontWeight: '600', fontSize: 13, color: c.primary },
  allChipTextSelected: { color: '#FFFFFF' },
  recsSection: { paddingTop: 4 },
  recsTitle: { fontSize: 17, fontWeight: '700', color: c.text, marginHorizontal: 16, marginBottom: 4 },
  recsStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 8 },
  recsStatusText: { fontSize: 13, color: c.subtext, marginHorizontal: 16, marginVertical: 8 },
  allTitle: { fontSize: 17, fontWeight: '700', color: c.text, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: c.subtext, fontSize: 15 },
});
