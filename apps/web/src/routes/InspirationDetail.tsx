import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Empty,
  Input,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import type { AnnotationDto, AssetDto, TimingDto } from '@flil/shared';
import { authedImageUrl, get, post } from '../api/client.js';
import {
  useBindSpot,
  useInspiration,
  useRecomputeWindows,
  useRecomputeSun,
  useSaveAnnotations,
  useSpots,
  useTags,
  useUploadAssets,
  useWindows,
} from '../api/hooks.js';
import { STATUS_META, fmtDateTime, hitRateText } from '../lib/format.js';
import { useSession } from '../stores/session.js';
import { AssetStrip } from '../components/AssetStrip.js';
import { AnnotationEditor, type DraftAnnotation } from '../components/AnnotationEditor.js';
import { TimingEditor } from '../components/TimingEditor.js';
import { WindowList } from '../components/WindowList.js';
import { TagPicker } from '../components/TagPicker.js';

export default function InspirationDetail() {
  const { id } = useParams<{ id: string }>();
  const tz = useSession((s) => s.libraryTz);
  const detail = useInspiration(id);
  const windows = useWindows(id);
  const { data: tags } = useTags();
  const { data: spots } = useSpots();
  const uploadAssets = useUploadAssets();
  const saveAnnotations = useSaveAnnotations();
  const recomputeSun = useRecomputeSun();
  const recomputeWindows = useRecomputeWindows();
  const bindSpot = useBindSpot();

  const [tagDraft, setTagDraft] = useState<string[] | null>(null);
  const [annotationTarget, setAnnotationTarget] = useState<AssetDto | null>(null);
  const [draftAnnotations, setDraftAnnotations] = useState<DraftAnnotation[]>([]);
  const [calibration, setCalibration] = useState<Record<string, unknown>[]>([]);
  const [editTiming, setEditTiming] = useState(false);

  const item = detail.data?.item;

  const lightBearingHint = useMemo(() => {
    const arrows = draftAnnotations.filter((a) => a.kind === 'light_arrow');
    const last = arrows[arrows.length - 1];
    return last ? (last.geometry.bearingDeg as number) : null;
  }, [draftAnnotations]);

  async function loadCalibration() {
    if (!id) return;
    const res = await get<{ items: Record<string, unknown>[] }>(`/inspirations/${id}/calibration`);
    setCalibration(res.items);
  }

  async function saveTags() {
    if (!id || !tagDraft) return;
    try {
      const current = new Set(item?.tags.map((t) => t.id) ?? []);
      const next = new Set(tagDraft);
      const addTagIds = [...next].filter((t) => !current.has(t));
      const removeTagIds = [...current].filter((t) => !next.has(t));
      await post('/inspirations/bulk-tag', { ids: [id], addTagIds, removeTagIds });
      message.success('标签已保存');
      setTagDraft(null);
      void detail.refetch();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function loadAnnotations(asset: AssetDto) {
    setAnnotationTarget(asset);
    try {
      const res = await get<{ items: AnnotationDto[] }>(`/assets/${asset.id}/annotations`);
      setDraftAnnotations(res.items.map((a) => ({ kind: a.kind, geometry: a.geometry, label: a.label })));
    } catch {
      setDraftAnnotations([]);
    }
  }

  async function saveAnnotationItems() {
    if (!annotationTarget) return;
    try {
      await saveAnnotations.mutateAsync({ assetId: annotationTarget.id, items: draftAnnotations });
      message.success('标注已保存（坐标已归一化，缩放不影响）');
      setAnnotationTarget(null);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function runSunRecompute(asset: AssetDto) {
    try {
      const res = await recomputeSun.mutateAsync(asset.id);
      message.success(
        `该照片拍摄时太阳仰角 ${res.sunElevation.toFixed(1)}°、方位角 ${res.sunAzimuth.toFixed(1)}°；` +
          `按当前机位朝向推算光位角约 ${Math.round(res.suggestedLightBearing)}°`,
      );
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  if (!item) {
    return detail.isError ? <Alert type="error" message={(detail.error as Error).message} /> : <Card loading />;
  }

  const fills = item.hitCount + item.partialCount + item.missCount;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            {item.title}
            <Tag color={STATUS_META[item.status].color}>{STATUS_META[item.status].label}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button size="small" onClick={() => void loadCalibration()}>
              查看校准历史
            </Button>
            <Button size="small" onClick={() => recomputeWindows.mutate({ id: item.id, days: 7 })} loading={recomputeWindows.isPending}>
              重算窗口
            </Button>
          </Space>
        }
      >
        <Row gutter={16}>
          <Col xs={24} lg={14}>
            <Upload
              multiple
              accept="image/*"
              showUploadList={false}
              beforeUpload={() => true}
              customRequest={async ({ file, onSuccess, onError }) => {
                try {
                  const res = await uploadAssets.mutateAsync({ id: item.id, files: [file as File], role: 'reference' });
                  const gps = res.items.some((x) => x.hasGpsExif);
                  message.success(gps ? '上传成功（原图含 GPS，按隐私策略只记录标记位，不入库坐标）' : '上传成功');
                  onSuccess?.(res);
                } catch (err) {
                  message.error((err as Error).message);
                  onError?.(err as Error);
                }
              }}
            >
              <Button type="primary" ghost style={{ marginBottom: 10 }}>
                上传参考图 / 实拍成片
              </Button>
            </Upload>

            <AssetStrip
              assets={item.assets}
              tz={tz}
              onPick={(a) => void loadAnnotations(a)}
            />

            <Divider />
            <Space wrap>
              <Typography.Text type="secondary">备注：</Typography.Text>
              <Typography.Text>{item.note ?? '—'}</Typography.Text>
            </Space>
            <div style={{ marginTop: 8 }}>
              <Space wrap>
                {item.tags.map((t) => (
                  <Tag key={t.id} color={t.source === 'manual' ? 'blue' : 'default'}>
                    {t.name}
                  </Tag>
                ))}
                <Button size="small" onClick={() => setTagDraft(item.tags.map((t) => t.id))}>
                  改标签
                </Button>
              </Space>
            </div>
          </Col>

          <Col xs={24} lg={10}>
            <Descriptions column={1} size="small" title="条件与机位">
              <Descriptions.Item label="时间锚">
                {item.timing ? `${item.timing.timeAnchor}（偏移 ${item.timing.anchorOffsetMin} 分）` : '未设置'}
              </Descriptions.Item>
              <Descriptions.Item label="命中率">{hitRateText(item.hitRate, fills)}</Descriptions.Item>
              <Descriptions.Item label="机位">
                {item.spot ? (
                  <Space direction="vertical" size={0}>
                    <span>{item.spot.placeName}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      对朝 {Math.round(item.spot.cameraBearing)}° · {item.spot.fuzz.label}
                    </Typography.Text>
                    {item.spot.precise ? (
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        精确坐标 {item.spot.precise.lat}, {item.spot.precise.lng}（仅你自己可见）
                      </Typography.Text>
                    ) : null}
                    {item.spot.accessNote ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {item.spot.accessNote}
                      </Typography.Text>
                    ) : null}
                  </Space>
                ) : (
                  <Space direction="vertical" size={4}>
                    <Typography.Text type="secondary">未绑定机位，窗口计算会跳过这张卡。</Typography.Text>
                    <Space>
                      <select
                        data-testid="spot-select"
                        defaultValue=""
                        onChange={async (e) => {
                          if (!e.target.value) return;
                          await bindSpot.mutateAsync({ id: item.id, spotId: e.target.value });
                          message.success('已绑定机位');
                        }}
                        style={{ padding: 4, borderRadius: 6, border: '1px solid #d9d9d9' }}
                      >
                        <option value="">选择机位…</option>
                        {(spots?.items ?? []).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.placeName}
                          </option>
                        ))}
                      </select>
                    </Space>
                  </Space>
                )}
              </Descriptions.Item>
            </Descriptions>
            <Button size="small" onClick={() => setEditTiming((v) => !v)}>
              {editTiming ? '收起条件编辑' : '编辑拍摄条件'}
            </Button>
          </Col>
        </Row>
      </Card>

      {tagDraft ? (
        <Card
          title="编辑标签"
          extra={
            <Space>
              <Button onClick={() => setTagDraft(null)}>取消</Button>
              <Button type="primary" onClick={saveTags}>
                保存
              </Button>
            </Space>
          }
        >
          <TagPicker tree={tags?.items ?? []} value={tagDraft} onChange={setTagDraft} />
        </Card>
      ) : null}

      {editTiming ? (
        <Card title="拍摄条件（时间锚 + 光位 + 天气画像）">
          <TimingEditor
            inspirationId={item.id}
            initial={(item.timing as TimingDto) ?? null}
            cameraBearing={item.spot?.cameraBearing ?? null}
            lightBearingHint={lightBearingHint}
            onSaved={() => {
              void detail.refetch();
              void windows.refetch();
            }}
          />
        </Card>
      ) : null}

      <WindowList
        inspirationId={item.id}
        windows={windows.data?.items ?? []}
        tz={tz}
        onPlanned={() => void detail.refetch()}
      />

      {calibration.length ? (
        <Card title="校准历史（系统学过什么，可撤销）">
          <Table
            size="small"
            rowKey={(r) => String(r.id)}
            pagination={false}
            dataSource={calibration}
            columns={[
              { title: '字段', dataIndex: 'field', width: 180 },
              {
                title: '变化',
                render: (_, r) => `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`,
              },
              { title: '原因', dataIndex: 'reason' },
              {
                title: '判定依据',
                width: 150,
                render: (_, r) => {
                  const causeLabel =
                    r.cause === 'timing_off' ? '同因：时间差了' : r.cause === 'weather_mismatch' ? '同因：天气不符' : null;
                  const evidenceCount = Array.isArray(r.evidence) ? r.evidence.length : 0;
                  return (
                    <Tooltip
                      title={
                        evidenceCount
                          ? `口径 v${r.ruleVersion ?? 1}；触发收紧的 ${evidenceCount} 条回填：${(r.evidence as string[]).join(', ')}`
                          : '历史记录（旧版口径，未存证据）'
                      }
                    >
                      <Space size={4}>
                        {causeLabel ? <Tag color="blue">{causeLabel}</Tag> : null}
                        {evidenceCount ? <Tag>{evidenceCount} 条回填</Tag> : null}
                      </Space>
                    </Tooltip>
                  );
                },
              },
              {
                title: '操作',
                width: 110,
                render: (_, r) =>
                  r.undoneAt ? (
                    <Tag>已撤销</Tag>
                  ) : (
                    <Button
                      size="small"
                      onClick={async () => {
                        await post(`/inspirations/${item.id}/calibration/${r.id}/undo`, {});
                        message.success('已撤销这次收窄');
                        void loadCalibration();
                        void detail.refetch();
                      }}
                    >
                      撤销
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Collapse
        items={[
          {
            key: 'annotations',
            label: '构图 / 光位标注（点缩略图开始画）',
            children:
              item.assets.length === 0 ? (
                <Empty description="先上传图片" />
              ) : (
                <Space wrap>
                  {item.assets.map((a) => (
                    <Space key={a.id} direction="vertical" size={4}>
                      <Button size="small" onClick={() => void loadAnnotations(a)}>
                        编辑这张的标注
                      </Button>
                      <Button size="small" onClick={() => void runSunRecompute(a)}>
                        反算当时太阳位置
                      </Button>
                    </Space>
                  ))}
                </Space>
              ),
          },
        ]}
      />

      <Modal
        open={Boolean(annotationTarget)}
        width={880}
        title="构图与光位标注"
        onCancel={() => setAnnotationTarget(null)}
        onOk={saveAnnotationItems}
        okText="保存标注"
        confirmLoading={saveAnnotations.isPending}
      >
        {annotationTarget ? (
          <AnnotationEditor
            imageUrl={authedImageUrl(`/assets/${annotationTarget.id}/file`)}
            initial={draftAnnotations}
            cameraBearing={item.spot?.cameraBearing ?? 0}
            onChange={setDraftAnnotations}
          />
        ) : null}
      </Modal>
    </Space>
  );
}
